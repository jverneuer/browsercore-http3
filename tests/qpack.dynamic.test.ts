/**
 * QPACK dynamic-table round-trips and wire instructions (PLAN.md Step 4).
 *
 * The static/dynamic round-trip in qpack.test.ts covers the happy path. This
 * file drives the dynamic QpackEncoder/QpackDecoder pair through scenarios that
 * exercise the otherwise-uncovered decoder representations and the encoder
 * instruction stream:
 *   - A second block that references a prior dynamic entry by post-base index
 *     (decodePostBaseIndexed), proving base arithmetic with sign bit.
 *   - Consuming encoder-stream instructions (Insert With Name Reference, Set
 *     Capacity, Duplicate) via consumeEncoderStream.
 *   - Decoder-stream instruction emission: Insert Count Increment, Section
 *     Acknowledgment, Stream Cancellation.
 *   - The literal-with-literal-name fallback (decodeLiteralLiteral) for a name
 *     absent from the static table.
 *   - Error paths: an invalid dynamic index, an invalid static index, a blocked
 *     decode (RIC > Insert Count), and an unknown encoder instruction byte.
 */

import { describe, it, expect } from "vitest";
import { QpackDecoder, QpackEncoder } from "../src/index.js";
import { decodeHeaders } from "../src/qpack/qpack.js";
import {
    ByteReader,
    readTaggedStringLiteral,
    writePrefixedIntWithBase,
} from "../src/qpack/encoding.js";
import { QpackDynamicTable, STATIC_TABLE } from "../src/qpack/qpack.js";
import { QpackDecodeError } from "../src/errors.js";
import { ByteWriter } from "../src/qpack/encoding.js";

describe("QpackEncoder — dynamic insert + post-base reference", () => {
    it("second block references the first dynamic entry by post-base index", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.applyMaxCapacity(1024);
        dec.applyMaxCapacity(1024);

        const headers = new Map([
            ["x-custom-one", "value-1"],
            ["x-custom-two", "value-2"],
        ]);
        const first = enc.encode(headers);
        dec.consumeEncoderStream(first.encoderBytes);
        const decodedFirst = dec.decode(first.block, first.requiredInsertCount);
        expect(decodedFirst.get("x-custom-one")).toBe("value-1");
        expect(decodedFirst.get("x-custom-two")).toBe("value-2");

        // Second block: same headers -> both now resolve to post-base refs
        // (base > 0, exercising the sign-bit path in readBase).
        const second = enc.encode(headers);
        expect(second.encoderBytes.length).toBe(0);
        dec.consumeEncoderStream(second.encoderBytes);
        const decodedSecond = dec.decode(second.block, second.requiredInsertCount);
        expect(decodedSecond.get("x-custom-one")).toBe("value-1");
        expect(decodedSecond.get("x-custom-two")).toBe("value-2");
    });

    it("inserts a literal-name field (decoder falls back to decodeLiteralLiteral)", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.applyMaxCapacity(1024);
        dec.applyMaxCapacity(1024);

        const headers = new Map([["x-totally-unknown-name", "some-value"]]);
        const { block, requiredInsertCount, encoderBytes } = enc.encode(headers);
        dec.consumeEncoderStream(encoderBytes);
        const decoded = dec.decode(block, requiredInsertCount);
        expect(decoded.get("x-totally-unknown-name")).toBe("some-value");
    });
});

describe("QpackDecoder — consumeEncoderStream (wire instructions)", () => {
    it("applies Insert With Name Reference and Set Capacity instructions", () => {
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);

        // First encode emits Set Capacity (1024) + Insert-With-Literal-Name.
        const produced = enc.encode(new Map([["k", "v"]]));
        dec.consumeEncoderStream(produced.encoderBytes);
        expect(dec.insertCount).toBe(1);

        // Second encode references the existing dynamic entry (no new insert).
        const reEncoded = enc.encode(new Map([["k", "v"]]));
        expect(reEncoded.encoderBytes.length).toBe(0);
        dec.consumeEncoderStream(reEncoded.encoderBytes);
        const decoded = dec.decode(reEncoded.block, reEncoded.requiredInsertCount);
        expect(decoded.get("k")).toBe("v");
    });

    it("applies a Duplicate encoder instruction", () => {
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const first = enc.encode(new Map([["dup", "val"]]));
        dec.consumeEncoderStream(first.encoderBytes);
        expect(dec.insertCount).toBe(1);

        // Duplicate: 000 <relativeIdx 5+>. Relative 0 -> absolute insertCount-1.
        const w = new ByteWriter();
        w.write(0x00 | 0); // duplicate relative index 0
        dec.consumeEncoderStream(w.toBytes());
        expect(dec.insertCount).toBe(2);
    });

    it("throws on a Duplicate with an invalid relative index", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        // Duplicate: 000 <idx 5+>. Relative index 20 maps to absolute
        // insertCount-1-20 = -21, which does not exist (empty table).
        const invalid = new Uint8Array([0x00 | 20]);
        expect(() => dec.consumeEncoderStream(invalid)).toThrow(/duplicate/);
    });

    it("applies an Insert-With-Name-Reference instruction (static)", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        // Insert With Name Reference, static: 1 T=1 <nameIdx 6+> <value>.
        // T=1, nameIdx 1 (:path) -> byte 0x80 | 0x20 | 1 = 0xa1.
        // Value "x" -> 0x01 0x78.
        const instr = new Uint8Array([0x80 | 0x20 | 1, 0x01, 0x78]);
        dec.consumeEncoderStream(instr);
        expect(dec.insertCount).toBe(1);
    });

    it("throws on an encoder-stream instruction with an invalid name reference", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        // Insert With Name Reference, dynamic: 1 T=0 <nameIdx 6+> <value>.
        // T=0 requires (prefixed >> 5) & 1 === 0, so prefixed < 32. Use
        // prefixed = 5 -> T=0, nameIndex 5, which is not in the empty table.
        // Byte = 0x80 | 5; value = length-prefixed "a" (0x01 0x61).
        const invalid = new Uint8Array([0x80 | 5, 0x01, 0x61]);
        expect(() => dec.consumeEncoderStream(invalid)).toThrow(QpackDecodeError);
    });

    it("throws on an unknown encoder instruction byte", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        // Top 3 bits 011 (0x60) matches none of the instruction prefixes.
        const invalid = new Uint8Array([0x60]);
        expect(() => dec.consumeEncoderStream(invalid)).toThrow(/unknown encoder instruction/);
    });
});

describe("QpackDecoder — representation error paths", () => {
    it("throws on an invalid dynamic literal-name reference", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const { block, requiredInsertCount, encoderBytes } = enc.encode(
            new Map([["k", "v"]]),
        );
        dec.consumeEncoderStream(encoderBytes);
        dec.decode(block, requiredInsertCount);

        // base = 1; literal name ref to dynamic index 12 (absolute = -12).
        // 0 1 N T=0 <idx 4+> -> 0x40 | 12 = 0x4c.
        const w = new ByteWriter();
        w.write(0x01); // RIC = 1
        w.write(0x00); // S=0, deltaBase = 0 -> base = 1
        w.write(0x40 | 12); // literal name ref, T=0, index 12
        w.write(0x01); // value length prefix
        w.write(0x61); // value "a"
        expect(() => dec.decode(w.toBytes(), 1)).toThrow(/invalid dynamic index/);
    });

    it("throws on an invalid post-base name reference", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const { block, requiredInsertCount, encoderBytes } = enc.encode(
            new Map([["k", "v"]]),
        );
        dec.consumeEncoderStream(encoderBytes);
        dec.decode(block, requiredInsertCount);

        // base = 1; post-base name ref to index 4 (absolute = 5).
        // Post-base name ref: 0 0 0 0 N T <idx 3+> -> 0x00 | 4.
        const w = new ByteWriter();
        w.write(0x01); // RIC = 1
        w.write(0x00); // S=0, deltaBase = 0 -> base = 1
        w.write(0x00 | 4); // post-base name ref, index 4
        w.write(0x01); // value length prefix
        w.write(0x61); // value "a"
        expect(() => dec.decode(w.toBytes(), 1)).toThrow(/post-base name ref/);
    });
});

describe("decodeHeaders (static-only) — malformed block error paths", () => {
    it("throws on an invalid static indexed index", () => {
        // decodeHeaders parses a static-table-only block. Index 99 (beyond
        // the 99-entry table, indices 0-98) must be encoded with a multi-byte
        // 6-bit prefix: 0xff then continuation 36 (63 + 36 = 99).
        const block = new Uint8Array([0x00, 0x00, 0xff, 0x36]);
        expect(() => decodeHeaders(block)).toThrow(/invalid static index/);
    });
});

describe("readTaggedStringLiteral — multi-byte length", () => {
    it("reads a name whose length hits the multi-byte prefix", () => {
        // n=5: max single-byte length = 31. A 31-byte name sets length === max,
        // triggering the multi-byte continuation path. base 0x40 keeps H=0.
        const nameBytes = new Uint8Array(31).fill(0x61);
        const w = new ByteWriter();
        writePrefixedIntWithBase(w, 0x40, nameBytes.length, 5);
        w.writeBytes(nameBytes);
        expect(readTaggedStringLiteral(new ByteReader(w.toBytes()), 5)).toBe(
            new TextDecoder().decode(nameBytes),
        );
    });
});

describe("QpackDecoder — post-base + literal-literal success paths", () => {
    it("decodes a post-base indexed reference", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.applyMaxCapacity(1024);
        dec.applyMaxCapacity(1024);

        // Insert two entries, then encode the same headers again so the second
        // block references them by post-base index.
        const headers = new Map([
            ["x-one", "1"],
            ["x-two", "2"],
        ]);
        const first = enc.encode(headers);
        dec.consumeEncoderStream(first.encoderBytes);
        dec.decode(first.block, first.requiredInsertCount);

        const second = enc.encode(headers);
        dec.consumeEncoderStream(second.encoderBytes);
        const decoded = dec.decode(second.block, second.requiredInsertCount);
        expect(decoded.get("x-one")).toBe("1");
        expect(decoded.get("x-two")).toBe("2");
    });

    it("decodes a literal-literal field via the static-only decoder", () => {
        // A header whose name is absent from the static table is encoded as a
        // literal-literal line (0 0 1 N H <NameLen 3+>) by encodeHeaders, and
        // decoded via decodeLiteralLiteral (the readBlockRepresentation
        // fallback).
        const headers = new Map([["x-not-in-static-table", "value"]]);
        const block = encodeHeaders(headers);
        const decoded = decodeHeaders(block);
        expect(decoded.get("x-not-in-static-table")).toBe("value");
    });

    it("decodes a literal-literal field via the dynamic decoder", () => {
        // Hand-build a block containing a literal-literal line (first byte in
        // 0x20-0x3f) and decode it with the dynamic decoder, exercising the
        // readBlockRepresentation fallback at decodeLiteralLiteral.
        // 0 0 1 N=0 H=0 <NameLen 3+>: name "abc" (len 3) -> 0x20|3 = 0x23.
        const w = new ByteWriter();
        w.write(0x00); // RIC = 0
        w.write(0x00); // S=0, deltaBase = 0
        w.write(0x20 | 3); // literal-literal, name length 3
        w.write(0x61); // "a"
        w.write(0x62); // "b"
        w.write(0x63); // "c"
        w.write(0x01); // value length prefix (H=0)
        w.write(0x7a); // value "z"
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const decoded = dec.decode(w.toBytes(), 0);
        expect(decoded.get("abc")).toBe("z");
    });

    it("decodes a literal name reference to the static table", () => {
        // 0 1 N T <NameIdx 4+>: reference to static index 1 (:path).
        // T=1 (static) is bit 4 (0x10); N=0, index 1 -> 0x40 | 0x10 | 1 = 0x51.
        // Value "x" -> 0x01 0x78.
        const w = new ByteWriter();
        w.write(0x00); // RIC = 0
        w.write(0x00); // S=0, deltaBase = 0
        w.write(0x40 | 0x10 | 1); // literal name ref, T=1 (static), index 1
        w.write(0x01); // value length prefix
        w.write(0x78); // value "x"
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const decoded = dec.decode(w.toBytes(), 0);
        expect(decoded.get(":path")).toBe("x");
    });

    it("decodes a literal name reference to a dynamic entry", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.applyMaxCapacity(1024);
        dec.applyMaxCapacity(1024);
        // Insert "k"->"v" (absolute index 0), then reference it dynamically.
        const first = enc.encode(new Map([["k", "v"]]));
        dec.consumeEncoderStream(first.encoderBytes);
        dec.decode(first.block, first.requiredInsertCount);

        // base = 1; literal name ref to dynamic index 0 (absolute = base-1-0 = 0).
        // 0 1 N T=0 <idx 4+> -> 0x40 | 0 = 0x40. Value "x" -> 0x01 0x78.
        const w = new ByteWriter();
        w.write(0x01); // RIC = 1
        w.write(0x00); // S=0, deltaBase = 0 -> base = 1
        w.write(0x40 | 0); // literal name ref, T=0 (dynamic), index 0
        w.write(0x01); // value length prefix
        w.write(0x78); // value "x"
        const decoded = dec.decode(w.toBytes(), 1);
        expect(decoded.get("k")).toBe("x");
    });
});

import { encodeHeaders } from "../src/qpack/qpack.js";

describe("QpackDecoder — decoder-stream instruction emission", () => {
    it("emits Insert Count Increment after consuming inserts", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const { encoderBytes } = enc.encode(new Map([["k", "v"]]));
        dec.consumeEncoderStream(encoderBytes);
        const ici = dec.emitInsertCountIncrement();
        // Wire format (RFC 9204 §4.4.3): 1 <Increment 6+> -> 0x80 | 1 = 0x81.
        expect(Array.from(ici)).toEqual([0x81]);
    });

    it("emits Section Acknowledgment and Stream Cancellation", () => {
        const dec = new QpackDecoder();
        const ack = dec.emitSectionAcknowledgment(10n);
        // Wire format (RFC 9204 §4.4.1): 0 0 <Stream ID 7+> -> 10.
        expect(Array.from(ack)).toEqual([10]);
        const cancel = dec.emitStreamCancellation(5n);
        // Wire format (RFC 9204 §4.4.2): 0 1 <Stream ID 6+> -> 0x40 | 5 = 0x45.
        expect(Array.from(cancel)).toEqual([0x45]);
    });
});

describe("QpackDecoder — error paths", () => {
    it("throws when Required Insert Count exceeds Insert Count (blocked)", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const w = new ByteWriter();
        w.write(0x05); // RIC = 5
        w.write(0x00); // S=0, deltaBase = 0
        w.write(0xc0 | 25); // static indexed index 25 = :status 200
        expect(() => dec.decode(w.toBytes(), 5)).toThrow(QpackDecodeError);
    });

    it("throws on an invalid static indexed index", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        // Static indexed: 1 T=1 <index 6+>. Index 99 is beyond the static table
        // (99 entries, indices 0-98), so it needs a multi-byte prefix.
        const w = new ByteWriter();
        w.write(0x00); // RIC = 0
        w.write(0x00); // S=0, deltaBase = 0
        w.write(0xff); // static indexed prefix (T=1, low6 = 63 = max)
        w.write(36); // continuation: 63 + 36 = 99
        expect(() => dec.decode(w.toBytes(), 0)).toThrow(/invalid static index/);
    });

    it("throws on an invalid dynamic indexed reference", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const { block, requiredInsertCount, encoderBytes } = enc.encode(
            new Map([["k", "v"]]),
        );
        dec.consumeEncoderStream(encoderBytes);
        dec.decode(block, requiredInsertCount);

        // base = 1; dynamic indexed referencing relative index 50 (invalid).
        const w = new ByteWriter();
        w.write(0x01); // RIC = 1
        w.write(0x00); // S=0, deltaBase = 0 -> base = 1
        w.write(0x80 | 50); // dynamic indexed, relative index 50
        expect(() => dec.decode(w.toBytes(), 1)).toThrow(/invalid dynamic index/);
    });

    it("throws on an invalid post-base index", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const { block, requiredInsertCount, encoderBytes } = enc.encode(
            new Map([["k", "v"]]),
        );
        dec.consumeEncoderStream(encoderBytes);
        dec.decode(block, requiredInsertCount);

        // base = 1; post-base indexed referencing index 5 (absolute = 6).
        const w = new ByteWriter();
        w.write(0x01); // RIC = 1
        w.write(0x00); // S=0, deltaBase = 0 -> base = 1
        w.write(0x10 | 5); // post-base indexed, index 5
        expect(() => dec.decode(w.toBytes(), 1)).toThrow(/post-base indexed/);
    });
});

describe("QpackDynamicTable — edge cases", () => {
    it("setCapacity to a smaller value evicts to fit", () => {
        const table = new QpackDynamicTable(1024);
        table.insert("a", "1");
        table.insert("b", "2");
        table.insert("c", "3");
        table.setCapacity(80);
        expect(table.length).toBeLessThan(3);
        expect(table.size).toBeLessThanOrEqual(80);
    });

    it("relativeToAbsolute maps relative 0 to the most recent entry", () => {
        const table = new QpackDynamicTable(1024);
        table.insert("a", "1");
        table.insert("b", "2");
        expect(table.relativeToAbsolute(0)).toBe(1);
        expect(table.relativeToAbsolute(1)).toBe(0);
    });

    it("getByAbsoluteIndex returns undefined for out-of-range indices", () => {
        const table = new QpackDynamicTable(1024);
        table.insert("a", "1");
        expect(table.getByAbsoluteIndex(-1)).toBeUndefined();
        expect(table.getByAbsoluteIndex(99)).toBeUndefined();
    });

    it("capacity getter reflects the current capacity", () => {
        const table = new QpackDynamicTable(1024);
        expect(table.capacity).toBe(1024);
        table.setCapacity(512);
        expect(table.capacity).toBe(512);
        table.setCapacity(0);
        expect(table.capacity).toBe(0);
    });

    it("getByAbsoluteIndex returns undefined after entries are evicted (stale insert count)", () => {
        // After eviction, nextAbsoluteIndex stays high while entries becomes empty.
        // getByAbsoluteIndex with an index in [0, nextAbsoluteIndex) reaches line 79,
        // where entries[0] is undefined — exercising the `?? 0` nullish fallback.
        const table = new QpackDynamicTable(1024);
        table.insert("a", "1");
        table.insert("b", "2");
        table.setCapacity(0);
        expect(table.length).toBe(0);
        expect(table.insertCount).toBe(2);
        // Absolute index 0 is < insertCount(2) but entries[0] is gone.
        expect(table.getByAbsoluteIndex(0)).toBeUndefined();
        expect(table.getByAbsoluteIndex(1)).toBeUndefined();
    });

    it("evictToFit breaks when entries is empty but totalSize is stale (defensive)", () => {
        // The `break` inside evictToFit guards against an inconsistent state where
        // entries is empty while totalSize > 0. Through the public API these stay
        // in sync, so we construct the state directly to exercise the defensive branch.
        const table = new QpackDynamicTable(1024);
        table.insert("a", "1");
        const internal = table as unknown as {
            entries: unknown[];
            totalSize: number;
            capacityValue: number;
            evictToFit(requiredSpace: number): void;
        };
        // Force entries empty and capacity to 0 while leaving totalSize positive,
        // so the while condition (totalSize > 0 && totalSize + 0 > 0) is true.
        internal.entries = [];
        internal.capacityValue = 0;
        expect(internal.totalSize).toBeGreaterThan(0);
        // Must not hang or throw — the defensive break exits the loop.
        internal.evictToFit(0);
        expect(table.size).toBeGreaterThan(0);
    });
});

describe("STATIC_TABLE", () => {
    it("contains the RFC 9204 Appendix A entries", () => {
        expect(STATIC_TABLE[0]).toEqual({ name: ":authority", value: "" });
        expect(STATIC_TABLE[1]).toEqual({ name: ":path", value: "/" });
        expect(STATIC_TABLE[25]).toEqual({ name: ":status", value: "200" });
        expect(STATIC_TABLE.length).toBeGreaterThan(90);
    });
});
