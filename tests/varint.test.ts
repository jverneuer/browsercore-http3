/**
 * QUIC varint encode/decode wire round-trip (PLAN.md Step 1).
 *
 * RFC 9000 §16: two-bit prefix selects a 1/2/4/8-byte representation, max
 * value 2^62 − 1. `getVarintEncodedLength` is covered in varint.properties.test.ts;
 * this file exercises the encode/decode pair and the decode error paths.
 */

import { describe, it, expect } from "vitest";
import { assertNever } from "../src/index.js";
import { decodeVarint, encodeVarint, readVarintPayload, VARINT_MAX, writeVarint } from "../src/index.js";

/** A varint length that the type system forbids (not 1/2/4/8). Used to exercise the assertNever default. */
const INVALID_VARINT_LENGTH = 3 as 1 as 1 | 2 | 4 | 8;

/** Boundary values: the bucket edges and the overall max. */
const BOUNDARIES = [
    0n,
    1n,
    (1n << 6n) - 1n, // 1-byte max
    1n << 6n, // 2-byte min
    (1n << 14n) - 1n, // 2-byte max
    1n << 14n, // 4-byte min
    (1n << 30n) - 1n, // 4-byte max
    1n << 30n, // 8-byte min
    VARINT_MAX, // 8-byte max (2^62 − 1)
];

describe("encodeVarint wire bytes", () => {
    it("1-byte form clears the prefix bits", () => {
        const bytes = encodeVarint(0n);
        expect(bytes).toEqual(new Uint8Array([0]));
        // Top two bits must be 00.
        expect(bytes[0]! >> 6).toBe(0);
    });

    it("sets the 01 prefix for the 2-byte form", () => {
        const bytes = encodeVarint(1n << 6n);
        expect(bytes).toHaveLength(2);
        expect(bytes[0]! >> 6).toBe(1);
    });

    it("sets the 10 prefix for the 4-byte form", () => {
        const bytes = encodeVarint(1n << 14n);
        expect(bytes).toHaveLength(4);
        expect(bytes[0]! >> 6).toBe(2);
    });

    it("sets the 11 prefix for the 8-byte form", () => {
        const bytes = encodeVarint(1n << 30n);
        expect(bytes).toHaveLength(8);
        expect(bytes[0]! >> 6).toBe(3);
    });

    it("encodes the max value in 8 bytes", () => {
        const bytes = encodeVarint(VARINT_MAX);
        expect(bytes).toHaveLength(8);
        // All 62 payload bits set.
        expect(bytes[0]!).toEqual(0xff);
        expect(bytes[1]!).toEqual(0xff);
        expect(bytes[7]!).toEqual(0xff);
    });
});

describe("decodeVarint wire bytes", () => {
    it("decodes a zero varint", () => {
        const { value, length } = decodeVarint(new Uint8Array([0]));
        expect(value).toBe(0n);
        expect(length).toBe(1);
    });

    it("reads only `length` bytes (ignores trailing data)", () => {
        // 1-byte value 5, followed by garbage that must NOT be consumed.
        const { value, length } = decodeVarint(new Uint8Array([5, 0xff, 0xff]));
        expect(value).toBe(5n);
        expect(length).toBe(1);
    });

    it("decodes the 2-byte form and masks the prefix", () => {
        // 0x40 | (64 >> 8) = 0x40, low byte = 64.
        const { value, length } = decodeVarint(new Uint8Array([0x40, 0x40]));
        expect(value).toBe(64n);
        expect(length).toBe(2);
    });
});

describe("encode/decode round-trip", () => {
    it("round-trips every boundary value", () => {
        for (const v of BOUNDARIES) {
            const bytes = encodeVarint(v);
            const { value, length } = decodeVarint(bytes);
            expect(value).toBe(v);
            expect(length).toBe(bytes.length);
        }
    });

    it("round-trips interior magnitudes", () => {
        const samples = [42n, 1000n, 123456n, 10n ** 9n, (1n << 40n) + 17n];
        for (const v of samples) {
            expect(decodeVarint(encodeVarint(v)).value).toBe(v);
        }
    });
});

describe("decodeVarint error paths", () => {
    it("throws RangeError on an empty buffer", () => {
        expect(() => decodeVarint(new Uint8Array(0))).toThrow(RangeError);
    });

    it("throws RangeError when the buffer is too short for the declared length", () => {
        // Prefix says 4 bytes but only 2 follow.
        const buf = new Uint8Array([0x80, 0x01]);
        expect(() => decodeVarint(buf)).toThrow(RangeError);
    });

    it("throws RangeError when an 8-byte varint is truncated", () => {
        // Prefix says 8 bytes but only 5 follow.
        const buf = new Uint8Array([0xc0, 0x01, 0x02, 0x03, 0x04]);
        expect(() => decodeVarint(buf)).toThrow(RangeError);
    });
});

describe("encodeVarint error paths", () => {
    it("throws RangeError on a negative value", () => {
        expect(() => encodeVarint(-1n)).toThrow(RangeError);
    });

    it("throws RangeError above VARINT_MAX", () => {
        expect(() => encodeVarint(VARINT_MAX + 1n)).toThrow(RangeError);
    });
});

describe("assertNever — exhaustiveness guard", () => {
    it("throws for any value cast to never", () => {
        // assertNever is the exhaustive-match fallback in writeVarint and
        // readVarintPayload: the type system guarantees it is never reached,
        // but it must still throw if somehow invoked. Proving it throws keeps
        // the default branch from being dead code.
        expect(() => assertNever("surprise" as never)).toThrow(/Unexpected value/);
        expect(() => assertNever(3 as never)).toThrow(/Unexpected value/);
        expect(() => assertNever(undefined as never)).toThrow(/Unexpected value/);
    });
});

describe("writeVarint — exhaustiveness default", () => {
    it("throws when called with a length the type system forbids", () => {
        // 3 is not a valid varint length; the type system forbids this call, so
        // we cast to exercise the assertNever guard — proving the default is a
        // real exhaustive-match fallback, not dead code.
        const out = new Uint8Array(3);
        expect(() => writeVarint(out, 0n, INVALID_VARINT_LENGTH)).toThrow(/Unexpected value/);
    });
});

describe("readVarintPayload — exhaustiveness default", () => {
    it("throws when called with a length the type system forbids", () => {
        // 3 is not a valid varint length; the type system forbids this call, so
        // we cast to exercise the assertNever guard — proving the default is a
        // real exhaustive-match fallback, not dead code.
        const at = (_i: number): number => 0;
        expect(() => readVarintPayload(at, INVALID_VARINT_LENGTH)).toThrow(/Unexpected value/);
    });
});
