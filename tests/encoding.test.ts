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

describe("writeStringLiteral / readStringLiteral (H=0)", () => {
    it("round-trips a short string", () => {
        const w = new ByteWriter();
        writeStringLiteral(w, "hello");
        const bytes = w.toBytes();
        expect(bytes[0]! & 0x80).toBe(0);
        expect(readStringLiteral(new ByteReader(bytes))).toBe("hello");
    });

    it("encodes a long string with a multi-byte length", () => {
        const longValue = "a".repeat(200);
        const w = new ByteWriter();
        writeStringLiteral(w, longValue);
        expect(readStringLiteral(new ByteReader(w.toBytes()))).toBe(longValue);
    });

    it("rejects H=1 (Huffman) string literals", () => {
        const bytes = new Uint8Array([0x81, 0x61]);
        expect(() => readStringLiteral(new ByteReader(bytes))).toThrow(QpackDecodeError);
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

    it("rejects H=1 (Huffman) tagged string literals", () => {
        // n=5: huffman mask is bit 4 (0x10). Set length 1 + H -> 0x11.
        const bytes = new Uint8Array([0x11, 0x61]);
        expect(() => readTaggedStringLiteral(new ByteReader(bytes), 5)).toThrow(QpackDecodeError);
    });
});
