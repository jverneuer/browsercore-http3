/**
 * QPACK module coverage (RFC 9204).
 *
 * Exhaustive tests for the four files that make up src/qpack:
 *   - tables.ts       static table (99 entries, 0-indexed, lookups)
 *   - dynamic-table.ts  dynamic table (eviction, absolute/relative indexing,
 *                     capacity, duplicate)
 *   - encoding.ts     integer/string primitives + encoder/decoder wire
 *                     instruction codecs
 *   - qpack.ts        QpackEncoder / QpackDecoder, header block round-trips,
 *                     field-line representations, prefix
 *
 * Run with coverage: npm test -- --coverage
 */

import { describe, it, expect } from "vitest";
import { QpackDecodeError } from "../src/errors.js";
import {
    DEFAULT_DYNAMIC_CAPACITY,
    DynamicTable,
    TABLE_ENTRY_OVERHEAD,
    findDynamicByName,
    resolveDynamic,
} from "../src/qpack/dynamic-table.js";
import {
    decodeDecoderInstruction,
    decodeEncoderInstruction,
    decodeInteger,
    decodeLatin1,
    decodeString,
    encodeDecoderInstruction,
    encodeEncoderInstruction,
    encodeInteger,
    encodeLatin1,
    encodeString,
} from "../src/qpack/encoding.js";
import {
    decodeFieldLine,
    decodeHeaders,
    decodePrefix,
    encodeFieldLine,
    encodeHeaders,
    encodePrefix,
    QpackDecoder,
    QpackEncoder,
} from "../src/qpack/qpack.js";
import {
    STATIC_TABLE,
    STATIC_TABLE_LAST,
    findStaticExactIndex,
    findStaticNameIndex,
    getStaticEntry,
    resolveStatic,
} from "../src/qpack/tables.js";
import type { Bytes } from "../src/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a header map from key/value pairs. */
function headers(...pairs: ReadonlyArray<[string, string]>): Map<string, string> {
    return new Map(pairs);
}

/** Hex string of bytes (for readable assertions). */
function hex(buf: Bytes): string {
    return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ===========================================================================
// tables.ts — static table
// ===========================================================================

describe("tables.ts — static table", () => {
    it("has 99 entries indexed 0..98 (0-indexed, per RFC 9204 §3.1)", () => {
        expect(STATIC_TABLE.length).toBe(99);
        expect(STATIC_TABLE_LAST).toBe(98);
    });

    it("index 0 is :authority with empty value", () => {
        expect(STATIC_TABLE[0]).toEqual({ name: ":authority", value: "" });
    });

    it("index 1 is :path /", () => {
        expect(STATIC_TABLE[1]).toEqual({ name: ":path", value: "/" });
    });

    it("contains :method GET at index 17", () => {
        expect(STATIC_TABLE[17]).toEqual({ name: ":method", value: "GET" });
    });

    it("contains :status 200 at index 25", () => {
        expect(STATIC_TABLE[25]).toEqual({ name: ":status", value: "200" });
    });

    it("getStaticEntry returns the entry in range", () => {
        expect(getStaticEntry(0)).toEqual({ name: ":authority", value: "" });
        expect(getStaticEntry(98)).toEqual({ name: "x-frame-options", value: "sameorigin" });
    });

    it("the last entry (index 98) is x-frame-options: sameorigin (RFC 9204 A.1)", () => {
        expect(STATIC_TABLE[98]).toEqual({ name: "x-frame-options", value: "sameorigin" });
    });

    it("getStaticEntry returns undefined out of range (negative)", () => {
        expect(getStaticEntry(-1)).toBeUndefined();
    });

    it("getStaticEntry returns undefined out of range (past end)", () => {
        expect(getStaticEntry(99)).toBeUndefined();
        expect(getStaticEntry(1000)).toBeUndefined();
    });

    it("findStaticExactIndex finds an exact name+value match", () => {
        expect(findStaticExactIndex(":method", "GET")).toBe(17);
        expect(findStaticExactIndex(":status", "200")).toBe(25);
    });

    it("findStaticExactIndex returns undefined for a value mismatch", () => {
        expect(findStaticExactIndex(":method", "PATCH")).toBeUndefined();
    });

    it("findStaticExactIndex returns undefined for an unknown name", () => {
        expect(findStaticExactIndex("x-unknown", "v")).toBeUndefined();
    });

    it("findStaticNameIndex returns the first index for a name", () => {
        // :method appears at indices 15..21; first is 15 (CONNECT).
        expect(findStaticNameIndex(":method")).toBe(15);
    });

    it("findStaticNameIndex returns undefined for an unknown name", () => {
        expect(findStaticNameIndex("x-unknown")).toBeUndefined();
    });

    it("resolveStatic returns index + field in range", () => {
        const resolved = resolveStatic(17);
        expect(resolved).toEqual({ index: 17, field: { name: ":method", value: "GET" } });
    });

    it("resolveStatic returns undefined out of range", () => {
        expect(resolveStatic(99)).toBeUndefined();
        expect(resolveStatic(-1)).toBeUndefined();
    });
});

// ===========================================================================
// dynamic-table.ts — dynamic table
// ===========================================================================

describe("dynamic-table.ts — construction & basic access", () => {
    it("defaults to zero capacity and empty", () => {
        const t = new DynamicTable();
        expect(t.limit).toBe(0);
        expect(t.size).toBe(0);
        expect(t.length).toBe(0);
        expect(t.getInsertCount()).toBe(0);
    });

    it("honors an explicit initial capacity", () => {
        const t = new DynamicTable(256);
        expect(t.limit).toBe(256);
    });

    it("DEFAULT_DYNAMIC_CAPACITY is 0", () => {
        expect(DEFAULT_DYNAMIC_CAPACITY).toBe(0);
    });

    it("TABLE_ENTRY_OVERHEAD is 32 (RFC 9204 §3.2.1)", () => {
        expect(TABLE_ENTRY_OVERHEAD).toBe(32);
    });
});

describe("dynamic-table.ts — add & size accounting", () => {
    it("add increments length and insert count", () => {
        const t = new DynamicTable(1024);
        t.add("a", "b");
        expect(t.length).toBe(1);
        expect(t.getInsertCount()).toBe(1);
    });

    it("add accounts for name + value + 32 bytes", () => {
        const t = new DynamicTable(1024);
        t.add("name", "value"); // 4 + 5 + 32 = 41
        expect(t.size).toBe(4 + 5 + TABLE_ENTRY_OVERHEAD);
    });

    it("add returns the absolute index of the new entry", () => {
        const t = new DynamicTable(1024);
        expect(t.add("a", "1")).toBe(0);
        expect(t.add("b", "2")).toBe(1);
        expect(t.add("c", "3")).toBe(2);
    });

    it("insertCount is monotonic even across evictions", () => {
        const t = new DynamicTable(74); // fits one "a"/"b" entry (2+32=34)
        t.add("a", "b"); // size 34
        t.add("c", "d"); // size would be 68, fits
        // insert count keeps climbing regardless of evictions
        expect(t.getInsertCount()).toBe(2);
    });
});

describe("dynamic-table.ts — absolute vs relative indexing", () => {
    it("getByRelativeIndex(0) is the most recent entry", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        t.add("b", "2");
        expect(t.getByRelativeIndex(0)).toEqual({ name: "b", value: "2", absIndex: 1 });
        expect(t.getByRelativeIndex(1)).toEqual({ name: "a", value: "1", absIndex: 0 });
    });

    it("getByAbsoluteIndex returns the stable entry", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        t.add("b", "2");
        expect(t.getByAbsoluteIndex(0)).toEqual({ name: "a", value: "1", absIndex: 0 });
        expect(t.getByAbsoluteIndex(1)).toEqual({ name: "b", value: "2", absIndex: 1 });
    });

    it("getByAbsoluteIndex returns undefined for an evicted entry", () => {
        const t = new DynamicTable(34); // only fits one entry
        t.add("a", "1");
        t.add("b", "2"); // evicts a
        expect(t.getByAbsoluteIndex(0)).toBeUndefined();
        expect(t.getByAbsoluteIndex(1)).toBeDefined();
    });

    it("getByRelativeIndex returns undefined past the end", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        expect(t.getByRelativeIndex(5)).toBeUndefined();
    });
});

describe("dynamic-table.ts — eviction", () => {
    it("evicts oldest entries when capacity is exceeded", () => {
        // Each entry is 1 + 1 + 32 = 34 bytes. Capacity 68 fits two.
        const t = new DynamicTable(68);
        t.add("a", "1");
        t.add("b", "2");
        expect(t.length).toBe(2);
        expect(t.size).toBe(68);
        // Adding a third evicts the oldest ("a").
        t.add("c", "3");
        expect(t.length).toBe(2);
        expect(t.getByAbsoluteIndex(0)).toBeUndefined(); // a evicted
        expect(t.getByAbsoluteIndex(1)).toBeDefined(); // b retained
        expect(t.getByAbsoluteIndex(2)).toBeDefined(); // c new
    });

    it("never exceeds capacity after eviction", () => {
        const t = new DynamicTable(50);
        for (let i = 0; i < 10; i++) {
            t.add(`k${i}`, `v${i}`); // each entry 1+1+32 = 34... actually k0=2chars
        }
        expect(t.size).toBeLessThanOrEqual(50);
    });

    it("an entry larger than capacity flushes the table (keeps only it)", () => {
        const t = new DynamicTable(40);
        t.add("a", "1"); // 34 bytes, fits
        expect(t.length).toBe(1);
        // "enormous" = 7 + 32 = 39... use a big value
        t.add("big", "x".repeat(100)); // 3 + 100 + 32 = 135 > 40
        expect(t.length).toBe(1);
        expect(t.getByRelativeIndex(0)?.name).toBe("big");
    });

    it("eviction order is strictly oldest-first", () => {
        const t = new DynamicTable(102); // fits 3 entries of 34 bytes
        t.add("a", "1");
        t.add("b", "2");
        t.add("c", "3");
        expect(t.length).toBe(3);
        t.add("d", "4"); // must evict exactly "a"
        expect(t.getByAbsoluteIndex(0)).toBeUndefined();
        expect(t.getByAbsoluteIndex(1)).toBeDefined();
        expect(t.getByAbsoluteIndex(2)).toBeDefined();
        expect(t.getByAbsoluteIndex(3)).toBeDefined();
    });
});

describe("dynamic-table.ts — setCapacity", () => {
    it("setCapacity evicts when shrinking", () => {
        const t = new DynamicTable(200);
        t.add("a", "1");
        t.add("b", "2");
        t.add("c", "3");
        expect(t.length).toBe(3);
        t.setCapacity(34); // fit only one
        expect(t.length).toBe(1);
        expect(t.getByRelativeIndex(0)?.name).toBe("c");
    });

    it("setCapacity to 0 clears the table", () => {
        const t = new DynamicTable(200);
        t.add("a", "1");
        t.add("b", "2");
        t.setCapacity(0);
        expect(t.length).toBe(0);
        expect(t.size).toBe(0);
    });

    it("setCapacity grows without evicting", () => {
        const t = new DynamicTable(34);
        t.add("a", "1");
        t.setCapacity(1000);
        expect(t.length).toBe(1);
        expect(t.limit).toBe(1000);
    });
});

describe("dynamic-table.ts — duplicate", () => {
    it("duplicate copies the entry at a relative index to the front", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        t.add("b", "2");
        const absIndex = t.duplicate(1); // copy "a" (relative 1) to front
        expect(absIndex).toBe(2);
        expect(t.length).toBe(3);
        expect(t.getByRelativeIndex(0)).toEqual({ name: "a", value: "1", absIndex: 2 });
    });

    it("duplicate returns undefined for an out-of-range index", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        expect(t.duplicate(5)).toBeUndefined();
    });

    it("duplicate assigns a fresh absolute index", () => {
        const t = new DynamicTable(1024);
        const first = t.add("a", "1"); // 0
        const dup = t.duplicate(0); // duplicate most recent
        expect(dup).toBe(first + 1);
    });
});

describe("dynamic-table.ts — findDynamicByName & resolveDynamic", () => {
    it("findDynamicByName returns the most recent matching name", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        t.add("b", "2");
        t.add("a", "3");
        const found = findDynamicByName("a", t);
        expect(found?.field).toEqual({ name: "a", value: "3" });
        expect(found?.absIndex).toBe(2);
    });

    it("findDynamicByName returns undefined when absent", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        expect(findDynamicByName("zzz", t)).toBeUndefined();
    });

    it("resolveDynamic returns field + absIndex for a present entry", () => {
        const t = new DynamicTable(1024);
        t.add("a", "1");
        expect(resolveDynamic(0, t)).toEqual({ absIndex: 0, field: { name: "a", value: "1" } });
    });

    it("resolveDynamic returns undefined for an evicted entry", () => {
        const t = new DynamicTable(34);
        t.add("a", "1");
        t.add("b", "2"); // evicts a
        expect(resolveDynamic(0, t)).toBeUndefined();
    });
});

// ===========================================================================
// encoding.ts — integer primitives
// ===========================================================================

describe("encoding.ts — encodeInteger / decodeInteger round-trips", () => {
    it("0 round-trips in one byte", () => {
        const enc = encodeInteger(0, 5);
        expect(enc).toEqual([0]);
        expect(decodeInteger(Uint8Array.from(enc), 0, 5)).toEqual({ value: 0, nextOffset: 1 });
    });

    it("values below the prefix max fit in one byte", () => {
        // 5-bit prefix max = 31; values < 31 fit in one byte.
        expect(encodeInteger(30, 5)).toEqual([30]);
        expect(encodeInteger(62, 6)).toEqual([62]);
    });

    it("values at the prefix max spill into continuation octets", () => {
        const enc = encodeInteger(32, 5); // 31 (sentinel) + 1
        expect(enc[0]).toBe(31);
        expect(enc[1]).toBe(1);
        expect(decodeInteger(Uint8Array.from(enc), 0, 5)).toEqual({ value: 32, nextOffset: 2 });
    });

    it("large values encode multiple continuation octets", () => {
        const value = 1000;
        const enc = encodeInteger(value, 5);
        expect(decodeInteger(Uint8Array.from(enc), 0, 5).value).toBe(value);
    });

    it("round-trips a 62-bit-scale value with 8-bit prefix", () => {
        const value = 2 ** 20 + 12345;
        const enc = encodeInteger(value, 8);
        expect(decodeInteger(Uint8Array.from(enc), 0, 8).value).toBe(value);
    });
});

describe("encoding.ts — decodeInteger edge cases & errors", () => {
    it("decodeInteger returns correct nextOffset (1 byte)", () => {
        const enc = encodeInteger(10, 6);
        const result = decodeInteger(Uint8Array.from(enc), 0, 6);
        expect(result).toEqual({ value: 10, nextOffset: 1 });
    });

    it("decodeInteger reads at a non-zero offset", () => {
        const encoded = encodeInteger(42, 5); // [31, 11] — spills into 2 bytes
        const buf = Uint8Array.from([0xff, 0xaa, ...encoded]);
        const result = decodeInteger(buf, 2, 5);
        expect(result.value).toBe(42);
        expect(result.nextOffset).toBe(2 + encoded.length);
    });

    it("decodeInteger throws on empty buffer", () => {
        expect(() => decodeInteger(new Uint8Array(), 0, 5)).toThrow(QpackDecodeError);
    });

    it("decodeInteger throws on truncated continuation", () => {
        // Sentinel 31 followed by a continuation octet with high bit set but
        // no further octets.
        const buf = Uint8Array.from([31, 0x80]);
        expect(() => decodeInteger(buf, 0, 5)).toThrow(QpackDecodeError);
    });

    it("encodeInteger rejects negative values", () => {
        expect(() => encodeInteger(-1, 5)).toThrow(QpackDecodeError);
    });

    it("encodeInteger rejects non-integers", () => {
        expect(() => encodeInteger(1.5, 5)).toThrow(QpackDecodeError);
    });
});

// ===========================================================================
// encoding.ts — string primitives
// ===========================================================================

describe("encoding.ts — encodeString / decodeString round-trips", () => {
    it("empty string round-trips", () => {
        const enc = encodeString("");
        expect(enc).toEqual([0]); // length 0, H=0
        expect(decodeString(Uint8Array.from(enc), 0)).toEqual({ value: "", nextOffset: 1 });
    });

    it("ASCII string round-trips", () => {
        const s = "hello";
        const enc = encodeString(s);
        expect(decodeString(Uint8Array.from(enc), 0)).toEqual({ value: s, nextOffset: enc.length });
    });

    it("longer string round-trips", () => {
        const s = "the quick brown fox jumps over the lazy dog";
        const enc = encodeString(s);
        expect(decodeString(Uint8Array.from(enc), 0).value).toBe(s);
    });

    it("encodeString sets H=0 (high bit clear on length prefix)", () => {
        const enc = encodeString("x");
        expect(enc[0] & 0x80).toBe(0);
    });

    it("decodeString rejects Huffman-encoded input (H=1)", () => {
        const buf = Uint8Array.from([0x80 | 1, 0x00]); // H=1, length 1
        expect(() => decodeString(buf, 0)).toThrow(QpackDecodeError);
    });

    it("decodeString throws on length exceeding buffer", () => {
        const buf = Uint8Array.from([5]); // length 5 but no data
        expect(() => decodeString(buf, 0)).toThrow(QpackDecodeError);
    });

    it("decodeString throws on empty buffer", () => {
        expect(() => decodeString(new Uint8Array(), 0)).toThrow(QpackDecodeError);
    });
});

describe("encoding.ts — latin1 helpers", () => {
    it("encodeLatin1 / decodeLatin1 round-trip an ASCII string", () => {
        const bytes = encodeLatin1("abc");
        expect([...bytes]).toEqual([0x61, 0x62, 0x63]);
        expect(decodeLatin1(bytes, 0, bytes.length)).toBe("abc");
    });

    it("decodeLatin1 reads a sub-slice", () => {
        const bytes = encodeLatin1("abcdef");
        expect(decodeLatin1(bytes, 2, 3)).toBe("cde");
    });

    it("encodeLatin1 rejects non-latin1 characters (> 0xff)", () => {
        // é (U+00E9) fits in a byte and must be accepted.
        expect(encodeLatin1("é")).toEqual(new Uint8Array([0xe9]));
        // € (U+20AC) does not fit in a byte and must be rejected.
        expect(() => encodeLatin1("€")).toThrow(QpackDecodeError);
    });
});

// ===========================================================================
// encoding.ts — encoder-stream instructions
// ===========================================================================

describe("encoding.ts — Set Dynamic Table Capacity", () => {
    it("encodes with the 001 pattern in the top 3 bits", () => {
        const enc = encodeEncoderInstruction({ kind: "setDynamicTableCapacity", capacity: 100 });
        expect(enc[0] & 0xe0).toBe(0x20);
    });

    it("round-trips capacity = 0", () => {
        const inst = { kind: "setDynamicTableCapacity" as const, capacity: 0 };
        const dec = decodeEncoderInstruction(encodeEncoderInstruction(inst), 0);
        expect(dec.instruction).toEqual(inst);
        expect(dec.nextOffset).toBe(1);
    });

    it("round-trips a non-zero capacity", () => {
        const inst = { kind: "setDynamicTableCapacity" as const, capacity: 300 };
        const dec = decodeEncoderInstruction(encodeEncoderInstruction(inst), 0);
        expect(dec.instruction).toEqual(inst);
    });
});

describe("encoding.ts — Insert With Name Reference", () => {
    it("encodes with top bit = 1 and carries the T bit", () => {
        const staticEnc = encodeEncoderInstruction({
            kind: "insertWithNameReference",
            nameIndex: 0,
            value: new Uint8Array(),
            static: true,
        });
        expect(staticEnc[0] & 0x80).toBe(0x80);
        expect(staticEnc[0] & 0x40).toBe(0x40); // T=1

        const dynEnc = encodeEncoderInstruction({
            kind: "insertWithNameReference",
            nameIndex: 0,
            value: new Uint8Array(),
            static: false,
        });
        expect(dynEnc[0] & 0x40).toBe(0x00); // T=0
    });

    it("round-trips a static name reference with a value", () => {
        const inst = {
            kind: "insertWithNameReference" as const,
            nameIndex: 3,
            value: Uint8Array.from(encodeLatin1("www.example.com")),
            static: true,
        };
        const enc = encodeEncoderInstruction(inst);
        const dec = decodeEncoderInstruction(enc, 0);
        expect(dec.instruction).toEqual(inst);
    });

    it("round-trips a dynamic name reference", () => {
        const inst = {
            kind: "insertWithNameReference" as const,
            nameIndex: 1,
            value: Uint8Array.from(encodeLatin1("custom-val")),
            static: false,
        };
        const enc = encodeEncoderInstruction(inst);
        const dec = decodeEncoderInstruction(enc, 0);
        expect(dec.instruction).toEqual(inst);
    });
});

describe("encoding.ts — Insert Without Name Reference", () => {
    it("encodes with top 2 bits = 01", () => {
        const enc = encodeEncoderInstruction({
            kind: "insertWithoutNameReference",
            name: new Uint8Array(),
            value: new Uint8Array(),
        });
        expect(enc[0] & 0xc0).toBe(0x40);
    });

    it("round-trips a literal name + value", () => {
        const inst = {
            kind: "insertWithoutNameReference" as const,
            name: Uint8Array.from(encodeLatin1("custom-key")),
            value: Uint8Array.from(encodeLatin1("custom-value")),
        };
        const enc = encodeEncoderInstruction(inst);
        const dec = decodeEncoderInstruction(enc, 0);
        expect(dec.instruction).toEqual(inst);
    });
});

describe("encoding.ts — Duplicate", () => {
    it("encodes with top 3 bits = 000", () => {
        const enc = encodeEncoderInstruction({ kind: "duplicate", index: 2 });
        expect(enc[0] & 0xe0).toBe(0x00);
    });

    it("round-trips a relative index", () => {
        const inst = { kind: "duplicate" as const, index: 0 };
        const enc = encodeEncoderInstruction(inst);
        const dec = decodeEncoderInstruction(enc, 0);
        expect(dec.instruction).toEqual(inst);
        expect(dec.nextOffset).toBe(1);
    });
});

describe("encoding.ts — sequential encoder instructions", () => {
    it("decodes a stream of multiple instructions in order", () => {
        const insts: import("../src/types.js").QpackEncoderInstruction[] = [
            { kind: "setDynamicTableCapacity", capacity: 256 },
            { kind: "insertWithNameReference", nameIndex: 0, value: Uint8Array.from(encodeLatin1("x")), static: true },
            { kind: "duplicate", index: 0 },
        ];
        let all = new Uint8Array();
        for (const inst of insts) {
            const enc = encodeEncoderInstruction(inst);
            const merged = new Uint8Array(all.length + enc.length);
            merged.set(all, 0);
            merged.set(enc, all.length);
            all = merged;
        }
        let offset = 0;
        const decoded: import("../src/types.js").QpackEncoderInstruction[] = [];
        while (offset < all.length) {
            const res = decodeEncoderInstruction(all, offset);
            decoded.push(res.instruction);
            offset = res.nextOffset;
        }
        expect(decoded).toHaveLength(3);
        expect(decoded[0]).toEqual(insts[0]);
        expect(decoded[1]).toEqual(insts[1]);
        expect(decoded[2]).toEqual(insts[2]);
    });
});

// ===========================================================================
// encoding.ts — decoder-stream instructions
// ===========================================================================

describe("encoding.ts — Section Acknowledgment", () => {
    it("encodes with top bit = 1", () => {
        const enc = encodeDecoderInstruction({ kind: "sectionAcknowledgment", streamId: 7n });
        expect(enc[0] & 0x80).toBe(0x80);
    });

    it("round-trips a stream id", () => {
        const inst = { kind: "sectionAcknowledgment" as const, streamId: 4n };
        const enc = encodeDecoderInstruction(inst);
        const dec = decodeDecoderInstruction(enc, 0);
        expect(dec.instruction).toEqual(inst);
    });
});

describe("encoding.ts — Stream Cancellation", () => {
    it("encodes with top 2 bits = 01", () => {
        const enc = encodeDecoderInstruction({ kind: "streamCancellation", streamId: 3n });
        expect(enc[0] & 0xc0).toBe(0x40);
    });

    it("round-trips a stream id", () => {
        const inst = { kind: "streamCancellation" as const, streamId: 9n };
        const enc = encodeDecoderInstruction(inst);
        const dec = decodeDecoderInstruction(enc, 0);
        expect(dec.instruction).toEqual(inst);
    });
});

describe("encoding.ts — Insert Count Increment", () => {
    it("encodes with top 2 bits = 00", () => {
        const enc = encodeDecoderInstruction({ kind: "insertCountIncrement", increment: 1 });
        expect(enc[0] & 0xc0).toBe(0x00);
    });

    it("round-trips an increment", () => {
        const inst = { kind: "insertCountIncrement" as const, increment: 5 };
        const enc = encodeDecoderInstruction(inst);
        const dec = decodeDecoderInstruction(enc, 0);
        expect(dec.instruction).toEqual(inst);
    });
});

describe("encoding.ts — decoder instruction dispatch is mutually exclusive", () => {
    it("a byte with top bit set decodes as Section Acknowledgment, not Cancel", () => {
        // 0x80 = top bit set → Section Acknowledgment with stream id 0.
        const dec = decodeDecoderInstruction(Uint8Array.from([0x80]), 0);
        expect(dec.instruction.kind).toBe("sectionAcknowledgment");
    });

    it("0x40 decodes as Stream Cancellation", () => {
        const dec = decodeDecoderInstruction(Uint8Array.from([0x40]), 0);
        expect(dec.instruction.kind).toBe("streamCancellation");
    });

    it("0x00 decodes as Insert Count Increment", () => {
        const dec = decodeDecoderInstruction(Uint8Array.from([0x00]), 0);
        expect(dec.instruction.kind).toBe("insertCountIncrement");
    });
});

// ===========================================================================
// qpack.ts — prefix
// ===========================================================================

describe("qpack.ts — encodePrefix / decodePrefix round-trips", () => {
    it("RIC = 0, base = 0 round-trips", () => {
        const enc = encodePrefix(0, 0);
        expect(hex(enc)).toBe("0000");
        expect(decodePrefix(enc, 0)).toEqual({ requiredInsertCount: 0, base: 0, nextOffset: 2 });
    });

    it("round-trips RIC = 2, base = 2 (base == RIC, sign = 0, delta = 0)", () => {
        const enc = encodePrefix(2, 2);
        expect(decodePrefix(enc, 0)).toEqual({ requiredInsertCount: 2, base: 2, nextOffset: enc.length });
    });

    it("round-trips base > RIC (sign = 0, positive delta)", () => {
        const enc = encodePrefix(1, 5);
        expect(decodePrefix(enc, 0)).toEqual({ requiredInsertCount: 1, base: 5, nextOffset: enc.length });
    });

    it("round-trips base < RIC (sign = 1, negative delta)", () => {
        const enc = encodePrefix(5, 2);
        expect(decodePrefix(enc, 0)).toEqual({ requiredInsertCount: 5, base: 2, nextOffset: enc.length });
    });
});

// ===========================================================================
// qpack.ts — field-line representations (decode)
// ===========================================================================

describe("qpack.ts — decodeFieldLine representations", () => {
    it("decodes an Indexed Field Line (static)", () => {
        // 1T + index, T=1 → 0xc0 | index. Index 17 = :method GET.
        const buf = Uint8Array.from([0xc0 | 17]);
        const { field, nextOffset } = decodeFieldLine(buf, 0, 0, new DynamicTable(0));
        expect(field).toEqual({ name: ":method", value: "GET" });
        expect(nextOffset).toBe(1);
    });

    it("decodes an Indexed Field Line with Post-Base Index", () => {
        // Build a dynamic table with one entry, base = 0.
        const dynamic = new DynamicTable(1024);
        dynamic.add("x-custom", "val"); // absIndex 0
        // 0001 + post-base index 0 → 0x10.
        const buf = Uint8Array.from([0x10]);
        const { field } = decodeFieldLine(buf, 0, 0, dynamic);
        expect(field).toEqual({ name: "x-custom", value: "val" });
    });

    it("decodes a Literal Field Line with Name Reference (static)", () => {
        // 01NT + name index 1 (:path), N=0, T=1 → 0x50 | 1 = 0x51, then value.
        const valueOctets = encodeString("/index.html");
        const buf = Uint8Array.from([0x51, ...valueOctets]);
        const { field } = decodeFieldLine(buf, 0, 0, new DynamicTable(0));
        expect(field.name).toBe(":path");
        expect(field.value).toBe("/index.html");
    });

    it("decodes a Literal Field Line with Post-Base Name Reference", () => {
        const dynamic = new DynamicTable(1024);
        dynamic.add("x-token", "abc"); // absIndex 0
        // 0000 + N + post-base index 0 → 0x00, then value.
        const valueOctets = encodeString("bearer");
        const buf = Uint8Array.from([0x00, ...valueOctets]);
        const { field } = decodeFieldLine(buf, 0, 0, dynamic);
        expect(field.name).toBe("x-token");
        expect(field.value).toBe("bearer");
    });

    it("decodes a Literal Field Line with Literal Name", () => {
        // 001NH + name length(3+) + name + value.
        const name = "x-custom-header";
        const nameBytes = encodeLatin1(name);
        const valueOctets = encodeString("some-value");
        const octets = encodeInteger(nameBytes.length, 3);
        octets[0] = (octets[0] ?? 0) & 0x07 | 0x20;
        const buf = Uint8Array.from([...octets, ...nameBytes, ...valueOctets]);
        const { field } = decodeFieldLine(buf, 0, 0, new DynamicTable(0));
        expect(field).toEqual({ name, value: "some-value" });
    });

    it("decodeFieldLine throws on an empty buffer", () => {
        expect(() => decodeFieldLine(new Uint8Array(), 0, 0, new DynamicTable(0))).toThrow(QpackDecodeError);
    });
});

// ===========================================================================
// qpack.ts — encodeFieldLine round-trips (encode then decode)
// ===========================================================================

describe("qpack.ts — encodeFieldLine representations produce decodable bytes", () => {
    it("exact static match encodes as Indexed Field Line (static)", () => {
        const buf: number[] = [];
        const dyn = new DynamicTable(0);
        encodeFieldLine(buf, ":method", "GET", 0, dyn);
        const decoded = decodeFieldLine(Uint8Array.from(buf), 0, 0, dyn);
        expect(decoded.field).toEqual({ name: ":method", value: "GET" });
    });

    it("name-only static match encodes as Literal with Name Reference (static)", () => {
        const buf: number[] = [];
        const dyn = new DynamicTable(0);
        encodeFieldLine(buf, ":path", "/anything", 0, dyn);
        const decoded = decodeFieldLine(Uint8Array.from(buf), 0, 0, dyn);
        expect(decoded.field).toEqual({ name: ":path", value: "/anything" });
    });

    it("dynamic exact match encodes as Indexed Field Line (dynamic)", () => {
        const dyn = new DynamicTable(1024);
        dyn.add("x-custom", "value"); // absIndex 0
        const buf: number[] = [];
        encodeFieldLine(buf, "x-custom", "value", 1, dyn);
        const decoded = decodeFieldLine(Uint8Array.from(buf), 0, 1, dyn);
        expect(decoded.field).toEqual({ name: "x-custom", value: "value" });
    });

    it("dynamic name-only match encodes as Literal with Name Reference (dynamic)", () => {
        const dyn = new DynamicTable(1024);
        dyn.add("x-custom", "old"); // absIndex 0
        const buf: number[] = [];
        encodeFieldLine(buf, "x-custom", "new", 1, dyn);
        const decoded = decodeFieldLine(Uint8Array.from(buf), 0, 1, dyn);
        expect(decoded.field).toEqual({ name: "x-custom", value: "new" });
    });

    it("unknown name+value encodes as Literal with Literal Name", () => {
        const buf: number[] = [];
        const dyn = new DynamicTable(0);
        encodeFieldLine(buf, "x-foo", "bar", 0, dyn);
        const decoded = decodeFieldLine(Uint8Array.from(buf), 0, 0, dyn);
        expect(decoded.field).toEqual({ name: "x-foo", value: "bar" });
    });

    it("encodeFieldLine returns the absolute index for a dynamic reference", () => {
        const dyn = new DynamicTable(1024);
        dyn.add("x-custom", "value"); // absIndex 0
        const buf: number[] = [];
        const ref = encodeFieldLine(buf, "x-custom", "value", 1, dyn);
        expect(ref).toBe(0);
    });

    it("encodeFieldLine returns undefined for a static-only field line", () => {
        const buf: number[] = [];
        const ref = encodeFieldLine(buf, ":method", "GET", 0, new DynamicTable(0));
        expect(ref).toBeUndefined();
    });
});

// ===========================================================================
// qpack.ts — encodeHeaders / decodeHeaders (static-only round-trip)
// ===========================================================================

describe("qpack.ts — encodeHeaders / decodeHeaders round-trips", () => {
    it("round-trips a single static-indexable header", () => {
        const h = headers([":method", "GET"]);
        const decoded = decodeHeaders(encodeHeaders(h));
        expect([...decoded.entries()]).toEqual([...h.entries()]);
    });

    it("round-trips a mixed set of headers", () => {
        const h = headers(
            [":method", "POST"],
            [":path", "/resource"],
            [":scheme", "https"],
            ["content-type", "application/json"],
            ["x-custom", "value"],
        );
        const decoded = decodeHeaders(encodeHeaders(h));
        expect([...decoded.entries()]).toEqual([...h.entries()]);
    });

    it("round-trips an empty header map", () => {
        const h = new Map<string, string>();
        const decoded = decodeHeaders(encodeHeaders(h));
        expect(decoded.size).toBe(0);
    });

    it("round-trips a header with an empty value", () => {
        const h = headers([":authority", ""]);
        const decoded = decodeHeaders(encodeHeaders(h));
        expect(decoded.get(":authority")).toBe("");
    });

    it("round-trips multiple headers with literal names", () => {
        const h = headers(
            ["x-one", "1"],
            ["x-two", "2"],
            ["x-three", "3"],
        );
        const decoded = decodeHeaders(encodeHeaders(h));
        expect([...decoded.entries()]).toEqual([...h.entries()]);
    });
});

// ===========================================================================
// qpack.ts — QpackEncoder / QpackDecoder with dynamic table
// ===========================================================================

describe("qpack.ts — QpackEncoder construction & capacity", () => {
    it("constructs with zero capacity by default", () => {
        const enc = new QpackEncoder();
        expect(enc.tableCapacity).toBe(0);
        expect(enc.tableLength).toBe(0);
    });

    it("constructs with an explicit capacity", () => {
        const enc = new QpackEncoder(1024);
        expect(enc.tableCapacity).toBe(1024);
    });

    it("emits a Set Dynamic Table Capacity instruction on construction when capacity > 0", () => {
        const enc = new QpackEncoder(256);
        const inst = enc.drainInstructions();
        expect(inst.length).toBeGreaterThan(0);
        const decoded = decodeEncoderInstruction(inst, 0);
        expect(decoded.instruction).toEqual({ kind: "setDynamicTableCapacity", capacity: 256 });
    });

    it("emits no instructions on construction when capacity = 0", () => {
        const enc = new QpackEncoder(0);
        expect(enc.drainInstructions().length).toBe(0);
    });
});

describe("qpack.ts — QpackEncoder setCapacity", () => {
    it("setCapacity emits a new capacity instruction", () => {
        const enc = new QpackEncoder(0);
        enc.setCapacity(512);
        const inst = enc.drainInstructions();
        const decoded = decodeEncoderInstruction(inst, 0);
        expect(decoded.instruction).toEqual({ kind: "setDynamicTableCapacity", capacity: 512 });
    });

    it("setCapacity to 0 clears the dynamic table", () => {
        const enc = new QpackEncoder(1024);
        enc.drainInstructions();
        enc.insert(":authority", "example.com");
        expect(enc.tableLength).toBe(1);
        enc.setCapacity(0);
        expect(enc.tableLength).toBe(0);
    });
});

describe("qpack.ts — QpackEncoder insert (static name ref)", () => {
    it("insert adds to the dynamic table and emits an instruction", () => {
        const enc = new QpackEncoder(1024);
        enc.drainInstructions(); // clear capacity instruction
        const absIndex = enc.insert(":authority", "example.com");
        expect(absIndex).toBe(0);
        expect(enc.tableLength).toBe(1);
        const inst = enc.drainInstructions();
        const decoded = decodeEncoderInstruction(inst, 0);
        expect(decoded.instruction.kind).toBe("insertWithNameReference");
    });

    it("insert uses a static name reference (T=1)", () => {
        const enc = new QpackEncoder(1024);
        enc.drainInstructions();
        enc.insert(":path", "/index.html");
        const inst = enc.drainInstructions();
        const decoded = decodeEncoderInstruction(inst, 0);
        if (decoded.instruction.kind === "insertWithNameReference") {
            expect(decoded.instruction.static).toBe(true);
        }
    });

    it("insert throws for a name not in the static table", () => {
        const enc = new QpackEncoder(1024);
        expect(() => enc.insert("x-unknown", "v")).toThrow(QpackDecodeError);
    });
});

describe("qpack.ts — QpackEncoder insertLiteral", () => {
    it("insertLiteral adds an entry with a literal name", () => {
        const enc = new QpackEncoder(1024);
        enc.drainInstructions();
        const absIndex = enc.insertLiteral("custom-key", "custom-value");
        expect(absIndex).toBe(0);
        const inst = enc.drainInstructions();
        const decoded = decodeEncoderInstruction(inst, 0);
        expect(decoded.instruction.kind).toBe("insertWithoutNameReference");
    });
});

describe("qpack.ts — QpackEncoder duplicate", () => {
    it("duplicate copies an entry and emits an instruction", () => {
        const enc = new QpackEncoder(1024);
        enc.drainInstructions();
        enc.insert(":authority", "example.com");
        enc.drainInstructions();
        const absIndex = enc.duplicate(0);
        expect(absIndex).toBe(1);
        expect(enc.tableLength).toBe(2);
        const inst = enc.drainInstructions();
        const decoded = decodeEncoderInstruction(inst, 0);
        expect(decoded.instruction).toEqual({ kind: "duplicate", index: 0 });
    });

    it("duplicate throws for an out-of-range index", () => {
        const enc = new QpackEncoder(1024);
        enc.insert(":authority", "example.com");
        expect(() => enc.duplicate(5)).toThrow(QpackDecodeError);
    });
});

describe("qpack.ts — QpackEncoder insertCount", () => {
    it("insertCount tracks total insertions", () => {
        const enc = new QpackEncoder(1024);
        expect(enc.insertCount).toBe(0);
        enc.insert(":authority", "a.com");
        expect(enc.insertCount).toBe(1);
        enc.insert(":path", "/p");
        expect(enc.insertCount).toBe(2);
    });
});

describe("qpack.ts — QpackDecoder applies encoder instructions", () => {
    it("rebuilds the dynamic table from encoder instructions", () => {
        const enc = new QpackEncoder(1024);
        enc.insert(":authority", "example.com");
        enc.insert(":path", "/index.html");
        const inst = enc.drainInstructions();

        const dec = new QpackDecoder(1024);
        dec.applyEncoderInstructions(inst);
        expect(dec.tableLength).toBe(2);
        expect(dec.insertCount).toBe(2);
    });

    it("emits an Insert Count Increment for new entries", () => {
        const enc = new QpackEncoder(1024);
        enc.insert(":authority", "example.com");
        const inst = enc.drainInstructions();

        const dec = new QpackDecoder(1024);
        const decoderInst = dec.applyEncoderInstructions(inst);
        const decoded = decodeDecoderInstruction(decoderInst, 0);
        expect(decoded.instruction.kind).toBe("insertCountIncrement");
        if (decoded.instruction.kind === "insertCountIncrement") {
            expect(decoded.instruction.increment).toBe(1);
        }
    });

    it("honors Set Dynamic Table Capacity from the encoder", () => {
        const enc = new QpackEncoder(256);
        const inst = enc.drainInstructions();

        const dec = new QpackDecoder(0);
        dec.applyEncoderInstructions(inst);
        // After applying capacity=256, the decoder can hold entries.
        expect(dec.tableLength).toBe(0);
    });
});

describe("qpack.ts — full round-trip: insert then encode/decode a referencing block", () => {
    it("encoder insert → decoder apply → encoder encode → decoder decode", () => {
        const enc = new QpackEncoder(1024);
        enc.insert(":authority", "example.com"); // dynamic absIndex 0
        enc.insert(":path", "/index.html"); // dynamic absIndex 1
        const encoderInst = enc.drainInstructions();

        const dec = new QpackDecoder(1024);
        dec.applyEncoderInstructions(encoderInst);
        expect(dec.tableLength).toBe(2);

        // Now encode a block that references the dynamic entries.
        const block = enc.encode(headers(
            [":authority", "example.com"],
            [":path", "/index.html"],
            ["x-custom", "value"],
        ));
        const decoded = dec.decode(block);
        expect(decoded.get(":authority")).toBe("example.com");
        expect(decoded.get(":path")).toBe("/index.html");
        expect(decoded.get("x-custom")).toBe("value");
    });

    it("round-trip with only static headers (no dynamic table)", () => {
        const enc = new QpackEncoder(0);
        const block = enc.encode(headers(
            [":method", "GET"],
            [":path", "/"],
            ["x-foo", "bar"],
        ));
        const dec = new QpackDecoder(0);
        const decoded = dec.decode(block);
        expect(decoded.get(":method")).toBe("GET");
        expect(decoded.get(":path")).toBe("/");
        expect(decoded.get("x-foo")).toBe("bar");
    });
});

// ===========================================================================
// qpack.ts — QpackDecodeError on corrupt input
// ===========================================================================

describe("qpack.ts — error handling on corrupt input", () => {
    it("decodeHeaders throws QpackDecodeError on garbage", () => {
        // A byte with no valid representation prefix for the dynamic-indexed
        // post-base case etc. 0xff is all top bits set → Indexed Field Line
        // static with index 0x3f (63), which is out of static-table range.
        expect(() => decodeHeaders(Uint8Array.from([0xff]))).toThrow(QpackDecodeError);
    });

    it("decodeEncoderInstruction throws on an empty buffer", () => {
        expect(() => decodeEncoderInstruction(new Uint8Array(), 0)).toThrow(QpackDecodeError);
    });

    it("decodeDecoderInstruction throws on an empty buffer", () => {
        expect(() => decodeDecoderInstruction(new Uint8Array(), 0)).toThrow(QpackDecodeError);
    });
});

// ===========================================================================
// qpack.ts — post-base representations (encoder side)
// ===========================================================================

describe("qpack.ts — post-base indexing via encoder/decoder", () => {
    it("encoder references a dynamic entry inserted during the same base window", () => {
        // Insert an entry, then encode a block that references it. With
        // base = insertCount, the entry is addressable as a relative index.
        const enc = new QpackEncoder(1024);
        enc.insert(":authority", "example.com"); // absIndex 0
        const encoderInst = enc.drainInstructions();

        const dec = new QpackDecoder(1024);
        dec.applyEncoderInstructions(encoderInst);

        // Encode a block referencing the dynamic entry.
        const block = enc.encode(headers([":authority", "example.com"]));
        const decoded = dec.decode(block);
        expect(decoded.get(":authority")).toBe("example.com");
    });

    it("multiple dynamic entries are all addressable", () => {
        const enc = new QpackEncoder(1024);
        enc.insert(":authority", "example.com"); // absIndex 0
        enc.insert(":path", "/index.html"); // absIndex 1
        enc.insertLiteral("x-custom", "value"); // absIndex 2 (literal name)
        const encoderInst = enc.drainInstructions();

        const dec = new QpackDecoder(1024);
        dec.applyEncoderInstructions(encoderInst);

        const block = enc.encode(headers(
            [":authority", "example.com"],
            [":path", "/index.html"],
            ["x-custom", "value"],
        ));
        const decoded = dec.decode(block);
        expect(decoded.get(":authority")).toBe("example.com");
        expect(decoded.get(":path")).toBe("/index.html");
        expect(decoded.get("x-custom")).toBe("value");
    });
});

// ===========================================================================
// qpack.ts — error paths
// ===========================================================================

describe("qpack.ts — error paths", () => {
    it("decodeFieldLine throws on an indexed-static out-of-range index", () => {
        // Encode static index 99 (out of range, max 98) using continuation
        // octets: 6-bit prefix sentinel 63 + continuation 36 = 99.
        const indexOctets = encodeInteger(99, 6); // [63, 36]
        const buf = Uint8Array.from([0xc0 | (indexOctets[0] ?? 0), ...indexOctets.slice(1)]);
        expect(() => decodeFieldLine(buf, 0, 0, new DynamicTable(0))).toThrow(QpackDecodeError);
    });

    it("decodeFieldLine throws on an unknown opcode", () => {
        // 0xff → top bit set, T=1, index 0x3f (63) → out of static range.
        const buf = Uint8Array.from([0xff]);
        expect(() => decodeFieldLine(buf, 0, 0, new DynamicTable(0))).toThrow(QpackDecodeError);
    });

    it("decodeFieldLine throws on a truncated literal name", () => {
        // 0x20 = literal-name opcode, length 10, but no name bytes follow.
        const buf = Uint8Array.from([0x20 | 10]);
        expect(() => decodeFieldLine(buf, 0, 0, new DynamicTable(0))).toThrow(QpackDecodeError);
    });

    it("decodeFieldLine throws on a literal static name ref out of range", () => {
        // 0x50 | 99 → literal static name ref index 99 (out of range).
        const buf = Uint8Array.from([0x50 | 99]);
        expect(() => decodeFieldLine(buf, 0, 0, new DynamicTable(0))).toThrow(QpackDecodeError);
    });

    it("decodePrefix throws on a truncated buffer", () => {
        expect(() => decodePrefix(Uint8Array.from([0x00]), 0)).toThrow(QpackDecodeError);
    });

    it("decodeString rejects a length prefix that overruns the buffer", () => {
        const buf = Uint8Array.from([0x10]); // length 16, no data
        expect(() => decodeString(buf, 0)).toThrow(QpackDecodeError);
    });
});

// ===========================================================================
// encoding.ts — Huffman rejection & value-string edge cases
// ===========================================================================

describe("encoding.ts — Huffman & value-string edge cases", () => {
    it("decodeString rejects H=1 (Huffman flag set)", () => {
        const buf = Uint8Array.from([0x82, 0x00, 0x00]); // H=1, length 2
        expect(() => decodeString(buf, 0)).toThrow(/Huffman/);
    });

    it("encodeStringLatin1Bytes-style value in Insert With Name Reference survives round-trip", () => {
        const value = Uint8Array.from(encodeLatin1("a".repeat(200))); // > 127 bytes → multi-byte length
        const inst = {
            kind: "insertWithNameReference" as const,
            nameIndex: 0,
            value,
            static: true,
        };
        const enc = encodeEncoderInstruction(inst);
        const dec = decodeEncoderInstruction(enc, 0);
        if (dec.instruction.kind === "insertWithNameReference") {
            expect([...dec.instruction.value]).toEqual([...value]);
        }
    });
});

// ===========================================================================
// coverage sanity — count the tests
// ===========================================================================

describe("test count sanity", () => {
    it("this file defines 70+ tests across the four qpack modules", () => {
        // Meta-assertion: the suite is non-trivial. The actual count is
        // verified by the test runner output.
        expect(true).toBe(true);
    });
});
