/**
 * QPACK low-level wire primitives (RFC 9204 / RFC 7541 §5).
 *
 * ByteWriter/ByteReader cursor behavior, the multi-byte branches of
 * writePrefixedInt / readPrefixedInt / writePrefixedIntWithBase, the overflow
 * guard in readPrefixedInt, and the H=1 (Huffman) rejection paths in the string
 * literal decoders. These complement encoding-load.test.ts (which only checks
 * that writeStringLiteral is callable).
 */

import { describe, it, expect } from "vitest";
import { QpackDecodeError } from "../src/errors.js";
import {
    ByteReader,
    ByteWriter,
    huffmanDecode,
    huffmanEncode,
    readPrefixedInt,
    readStringLiteral,
    readTaggedStringLiteral,
    writePrefixedInt,
    writePrefixedIntWithBase,
    writeStringLiteral,
} from "../src/qpack/encoding.js";

describe("ByteWriter / ByteReader cursors", () => {
    it("reports offset and remaining as the cursor advances", () => {
        const w = new ByteWriter();
        w.write(1);
        w.write(2);
        w.writeBytes(new Uint8Array([3, 4]));
        const bytes = w.toBytes();
        expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);

        const r = new ByteReader(bytes);
        expect(r.offset).toBe(0);
        expect(r.remaining).toBe(4);
        r.read();
        r.read();
        expect(r.offset).toBe(2);
        expect(r.remaining).toBe(2);
        r.readBytes(2);
        expect(r.offset).toBe(4);
        expect(r.remaining).toBe(0);
    });

    it("readBytes past the end throws QpackDecodeError", () => {
        const r = new ByteReader(new Uint8Array([1, 2]));
        r.read();
        expect(() => r.readBytes(5)).toThrow(QpackDecodeError);
    });

    it("peek/read at the end throws QpackDecodeError", () => {
        const r = new ByteReader(new Uint8Array([7]));
        r.read();
        expect(() => r.peek()).toThrow(QpackDecodeError);
        expect(() => r.read()).toThrow(QpackDecodeError);
    });
});

describe("writePrefixedInt — single and multi-byte", () => {
    it("fits a value below the prefix max in one byte", () => {
        const w = new ByteWriter();
        writePrefixedInt(w, 42, 6);
        expect(Array.from(w.toBytes())).toEqual([42]);
    });

    it("switches to multi-byte continuation when value >= max", () => {
        const w = new ByteWriter();
        writePrefixedInt(w, 63, 6);
        expect(Array.from(w.toBytes())).toEqual([63, 0]);
    });

    it("encodes a large value across multiple continuation bytes", () => {
        const w = new ByteWriter();
        writePrefixedInt(w, 200, 6);
        expect(readPrefixedInt(new ByteReader(w.toBytes()), 6)).toBe(200);
    });
});

describe("readPrefixedInt — multi-byte and overflow guard", () => {
    it("reads a multi-byte value (first byte == max)", () => {
        const w = new ByteWriter();
        writePrefixedInt(w, 300, 6);
        expect(readPrefixedInt(new ByteReader(w.toBytes()), 6)).toBe(300);
    });

    it("throws QpackDecodeError on the prefixed-integer overflow guard (m > 62)", () => {
        const bytes = [63, ...Array.from({ length: 10 }, () => 0xff)];
        expect(() => readPrefixedInt(new ByteReader(Uint8Array.from(bytes)), 6)).toThrow(
            QpackDecodeError,
        );
    });
});

describe("writePrefixedIntWithBase — multi-byte spill", () => {
    it("writes the base tag when the value fits", () => {
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x50, 7, 4);
        expect(Array.from(w.toBytes())).toEqual([0x57]);
    });

    it("spills into continuation bytes when value >= max", () => {
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x50, 20, 4);
        expect(Array.from(w.toBytes())).toEqual([0x5f, 5]);
    });

    it("spills across multiple continuation bytes (remaining >= 128)", () => {
        // n=4: max=15. value=200 -> remaining=185 >= 128, so the loop body
        // executes at least once. 185 = 57 + 128 -> bytes: 0x5f, (57+128)=185, 1.
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x50, 200, 4);
        const bytes = w.toBytes();
        // round-trip to verify correctness
        // Read back: prefix byte 0x5f -> base 0x50, length prefix low 4 bits = 15 (max)
        // -> multi-byte: 185, 1 -> 15 + 185*1 + 1*128 = 15+185+128 = 328? No.
        // readPrefixedInt: value = 15 (masked), then byte 185 -> value += (185&0x7f)<<0 = 57
        // -> 15+57=72, then byte 1 -> value += (1&0x7f)<<7 = 128 -> 72+128=200. Correct.
        expect(readPrefixedInt(new ByteReader(bytes), 4)).toBe(200);
    });
});

describe("writeStringLiteral / readStringLiteral (H=1 Huffman)", () => {
    it("round-trips a short string", () => {
        const w = new ByteWriter();
        writeStringLiteral(w, "hello");
        const bytes = w.toBytes();
        // H=1: the high bit of the length prefix is set.
        expect(bytes[0]! & 0x80).toBe(0x80);
        expect(readStringLiteral(new ByteReader(bytes))).toBe("hello");
    });

    it("encodes a long string with a multi-byte length", () => {
        const longValue = "a".repeat(200);
        const w = new ByteWriter();
        writeStringLiteral(w, longValue);
        expect(readStringLiteral(new ByteReader(w.toBytes()))).toBe(longValue);
    });

    it("decodes a real Huffman-encoded value (H=1)", () => {
        const raw = new TextEncoder().encode("gzip");
        const encoded = huffmanEncode(raw);
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x80, encoded.length, 7);
        w.writeBytes(encoded);
        expect(readStringLiteral(new ByteReader(w.toBytes()))).toBe("gzip");
    });

    it("still decodes H=0 (literal) string literals", () => {
        const bytes = new Uint8Array([0x01, 0x61]);
        expect(readStringLiteral(new ByteReader(bytes))).toBe("a");
    });

    it("decodes a hand-built Huffman value for 'www.example.com'", () => {
        const value = "www.example.com";
        const encoded = huffmanEncode(new TextEncoder().encode(value));
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x80, encoded.length, 7);
        w.writeBytes(encoded);
        expect(readStringLiteral(new ByteReader(w.toBytes()))).toBe(value);
    });
});

describe("huffmanEncode — defensive invalid-byte error (encoding.ts:86)", () => {
    it("throws QpackDecodeError when a byte value is not in HUFFMAN_TABLE", () => {
        // All byte values 0-255 are present in HUFFMAN_TABLE, and index 256 is
        // the defined EOS entry. The defensive throw at encoding.ts:86 is only
        // reachable with an index > 256 — which a real Uint8Array cannot hold
        // (its values are always 0-255). Bypass the type to exercise the branch.
        expect(() => huffmanEncode([257] as unknown as Uint8Array)).toThrow(QpackDecodeError);
    });
});

describe("readStringLiteral — multi-byte length prefix (encoding.ts:259-264)", () => {
    it("decodes a string whose Huffman-encoded length forces a multi-byte length prefix", () => {
        // A string of 250 'a's Huffman-encodes to 157 bytes, which exceeds the
        // 7-bit prefix max (127). writeStringLiteral then emits a multi-byte
        // length prefix (0xff, 0x1e), forcing readStringLiteral to take the
        // length === max branch (encoding.ts:259-264) to recover the length.
        const longValue = "a".repeat(250);
        const w = new ByteWriter();
        writeStringLiteral(w, longValue);
        const bytes = w.toBytes();
        expect(bytes[0]).toBe(0xff); // length prefix hit 7-bit max -> multi-byte
        expect(readStringLiteral(new ByteReader(bytes))).toBe(longValue);
    });
});

describe("readTaggedStringLiteral", () => {
    it("round-trips a tagged (n-bit prefix) string", () => {
        const nameBytes = new TextEncoder().encode("custom-key");
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x40, nameBytes.length, 5);
        w.writeBytes(nameBytes);
        expect(readTaggedStringLiteral(new ByteReader(w.toBytes()), 5)).toBe("custom-key");
    });

    it("decodes a Huffman (H=1) tagged string literal", () => {
        // n=5: per the code's huffmanMask = 1 << n, the H flag is at bit 5 (0x20).
        const value = "custom-key";
        const encoded = huffmanEncode(new TextEncoder().encode(value));
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x40 | 0x20, encoded.length, 5);
        w.writeBytes(encoded);
        expect(readTaggedStringLiteral(new ByteReader(w.toBytes()), 5)).toBe(value);
    });
});

describe("huffmanDecode — no matching code error (encoding.ts:128)", () => {
    it("throws QpackDecodeError when no Huffman code matches the bit pattern", () => {
        // 0xff = 0b11111111. No prefix-free Huffman code in the table matches
        // these bits at any length:
        //   5-bit codes: 0x00-0x09  -> top 5 bits 0x1f (31) is not in range
        //   6-bit codes: 0x14-0x18  -> top 6 bits 0x3f (63) is not in range
        //   7-bit codes: 0x5c-0x73  -> top 7 bits 0x7f (127) is not in range
        //   8-bit codes: 0xf8-0xfd  -> top 8 bits 0xff (255) is not in range
        // The decoder exhausts the table with no match and throws at line 128.
        const reader = new ByteReader(new Uint8Array([0xff]));
        expect(() => huffmanDecode(reader, 1)).toThrow(QpackDecodeError);
    });
});
