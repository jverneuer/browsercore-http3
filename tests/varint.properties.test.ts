/**
 * Property-style tests for getVarintEncodedLength.
 *
 * Boundary values for each varint bucket are covered in http3.test.ts. Here we
 * cross-check the function against an INDEPENDENT reference implementation
 * built on bit-length counting, across a structured sample of the full
 * [0, 2^62) input range plus the exact bucket edges.
 *
 * The QUIC varint spec (RFC 9000 §16) only ever produces 1, 2, 4, or 8 bytes —
 * never 3, 5, 6, 7. Pinning that here guards against a future refactor that
 * accidentally introduces, say, a 3-byte encoding.
 */

import { describe, it, expect } from "vitest";
import { getVarintEncodedLength, VARINT_MAX } from "../src/index.js";

/**
 * Independent reference: count the minimum bits needed to represent `value`,
 * then map bit-width → QUIC varint length. This is derived from the spec's
 * "6/14/30/62 payload-bit" rule rather than from the source's comparison
 * ladder, so it exercises the same contract from a different angle.
 */
function expectedLength(value: bigint): number {
    if (value < 0n) throw new RangeError("negative");
    if (value === 0n) return 1;
    let bits = 0n;
    let v = value;
    while (v > 0n) {
        bits += 1n;
        v >>= 1n;
    }
    if (bits <= 6n) return 1;
    if (bits <= 14n) return 2;
    if (bits <= 30n) return 4;
    return 8;
}

/** A structured, deterministic sample spanning the whole [0, 2^62) range. */
function sampleValues(): bigint[] {
    const out: bigint[] = [0n];
    // Every power of two from 2^0 .. 2^61, plus the boundary neighbors.
    for (let i = 0n; i < 62n; i += 1n) {
        const p = 1n << i;
        out.push(p);
        if (p > 0n) out.push(p - 1n);
        out.push(p + 1n);
    }
    // The four bucket thresholds and their ±1 neighbors.
    for (const t of [1n << 6n, 1n << 14n, 1n << 30n]) {
        out.push(t - 1n, t, t + 1n);
    }
    // A handful of interior magnitudes.
    out.push(1n, 50n, 200n, 10_000n, 1_000_000n, 10n ** 12n, 10n ** 18n);
    // The maximum encodable value (2^62 - 1).
    out.push(VARINT_MAX);
    return out;
}

describe("getVarintEncodedLength — output space", () => {
    it("only ever returns 1, 2, 4, or 8 (never 3/5/6/7)", () => {
        const allowed = new Set([1, 2, 4, 8]);
        for (const v of sampleValues()) {
            expect(allowed.has(getVarintEncodedLength(v))).toBe(true);
        }
    });
});

describe("getVarintEncodedLength — matches independent bit-width reference", () => {
    it("agrees with expectedLength() across the structured sample", () => {
        for (const v of sampleValues()) {
            expect(getVarintEncodedLength(v)).toBe(expectedLength(v));
        }
    });

    it("is monotonic non-decreasing across ascending powers of two", () => {
        let prev = 0;
        for (let i = 0n; i < 62n; i += 1n) {
            const len = getVarintEncodedLength(1n << i);
            expect(len).toBeGreaterThanOrEqual(prev);
            prev = len;
        }
        // Final power-of-two within range lands in the 8-byte bucket.
        expect(prev).toBe(8);
    });
});

describe("getVarintEncodedLength — exact bucket edges", () => {
    it("2^6 - 1 is one byte, 2^6 is two bytes", () => {
        expect(getVarintEncodedLength((1n << 6n) - 1n)).toBe(1);
        expect(getVarintEncodedLength(1n << 6n)).toBe(2);
    });

    it("2^14 - 1 is two bytes, 2^14 is four bytes", () => {
        expect(getVarintEncodedLength((1n << 14n) - 1n)).toBe(2);
        expect(getVarintEncodedLength(1n << 14n)).toBe(4);
    });

    it("2^30 - 1 is four bytes, 2^30 is eight bytes", () => {
        expect(getVarintEncodedLength((1n << 30n) - 1n)).toBe(4);
        expect(getVarintEncodedLength(1n << 30n)).toBe(8);
    });

    it("VARINT_MAX (2^62 - 1) is eight bytes; 2^62 overflows", () => {
        expect(getVarintEncodedLength(VARINT_MAX)).toBe(8);
        expect(() => getVarintEncodedLength(1n << 62n)).toThrow(RangeError);
    });
});

describe("getVarintEncodedLength — error paths", () => {
    it("rejects negative values across several magnitudes", () => {
        for (const v of [-1n, -2n, -(1n << 100n)]) {
            expect(() => getVarintEncodedLength(v)).toThrow(RangeError);
        }
    });

    it("rejects values strictly above VARINT_MAX", () => {
        expect(() => getVarintEncodedLength(VARINT_MAX + 1n)).toThrow(RangeError);
        expect(() => getVarintEncodedLength(VARINT_MAX + 1_000_000n)).toThrow(RangeError);
    });
});
