/**
 * QUIC variable-length integer encoding (RFC 9000 §16).
 *
 * Used for stream ids, frame types, frame lengths, SETTINGS ids/values, and
 * push ids throughout HTTP/3. Two-bit prefix selects the length: 1, 2, 4, or
 * 8 bytes. The two high-order bits of the first byte encode the length:
 *   00 -> 1 byte (6 payload bits, max 2^6 − 1)
 *   01 -> 2 bytes (14 payload bits, max 2^14 − 1)
 *   10 -> 4 bytes (30 payload bits, max 2^30 − 1)
 *   11 -> 8 bytes (62 payload bits, max 2^62 − 1)
 */

import { VARINT_MAX, type Bytes } from "../types.js";
import { assertNever } from "../utils.js";

/** The only valid varint encoded lengths (RFC 9000 §16). */
type VarintLength = 1 | 2 | 4 | 8;

/** A varint that has been decoded from the wire, plus the bytes it occupied. */
export interface DecodedVarint {
    readonly value: bigint;
    readonly length: number;
}

/** Return the number of bytes needed to encode `value` as a varint. */
export function getVarintEncodedLength(value: bigint): VarintLength {
    if (value < 0n) {
        throw new RangeError(`varint cannot be negative: ${value}`);
    }
    if (value > VARINT_MAX) {
        throw new RangeError(`varint overflow: ${value}`);
    }
    if (value < (1n << 6n)) {
        return 1;
    }
    if (value < (1n << 14n)) {
        return 2;
    }
    if (value < (1n << 30n)) {
        return 4;
    }
    return 8;
}

/**
 * Write a varint's payload into a pre-allocated buffer of the correct length.
 * The switch is exhaustive over {@link VarintLength}; the `default` is a
 * compile-time exhaustiveness guard. Exported so the guard is independently
 * testable (via cast) — matching the quic package's `encodeVarintInto`.
 */
export function writeVarint(out: Bytes, value: bigint, length: VarintLength): void {
    switch (length) {
        case 1:
            out[0] = Number(value);
            break;
        case 2:
            out[0] = Number(value >> 8n) | 0x40;
            out[1] = Number(value & 0xffn);
            break;
        case 4:
            out[0] = Number(value >> 24n) | 0x80;
            out[1] = Number((value >> 16n) & 0xffn);
            out[2] = Number((value >> 8n) & 0xffn);
            out[3] = Number(value & 0xffn);
            break;
        case 8:
            out[0] = Number(value >> 56n) | 0xc0;
            out[1] = Number((value >> 48n) & 0xffn);
            out[2] = Number((value >> 40n) & 0xffn);
            out[3] = Number((value >> 32n) & 0xffn);
            out[4] = Number((value >> 24n) & 0xffn);
            out[5] = Number((value >> 16n) & 0xffn);
            out[6] = Number((value >> 8n) & 0xffn);
            out[7] = Number(value & 0xffn);
            break;
        default:
            // Exhaustiveness guard: VarintLength is 1 | 2 | 4 | 8, all handled above.
            assertNever(length);
    }
}

/** Encode a varint to its wire representation. */
export function encodeVarint(value: bigint): Bytes {
    const length = getVarintEncodedLength(value);
    const out = new Uint8Array(length);
    writeVarint(out, value, length);
    return out;
}

/**
 * Read a varint payload from a byte source using the bounds-safe `at`
 * accessor. The switch is exhaustive over {@link VarintLength}; the `default`
 * is a compile-time exhaustiveness guard. Exported so the guard is
 * independently testable (via cast).
 */
export function readVarintPayload(at: (i: number) => number, length: VarintLength): bigint {
    const masked = BigInt(at(0) & 0x3f);
    let value: bigint;
    switch (length) {
        case 1:
            value = masked;
            break;
        case 2:
            value = (masked << 8n) | BigInt(at(1));
            break;
        case 4:
            value =
                (masked << 24n) |
                (BigInt(at(1)) << 16n) |
                (BigInt(at(2)) << 8n) |
                BigInt(at(3));
            break;
        case 8:
            value =
                (masked << 56n) |
                (BigInt(at(1)) << 48n) |
                (BigInt(at(2)) << 40n) |
                (BigInt(at(3)) << 32n) |
                (BigInt(at(4)) << 24n) |
                (BigInt(at(5)) << 16n) |
                (BigInt(at(6)) << 8n) |
                BigInt(at(7));
            break;
        default:
            // Exhaustiveness guard: VarintLength is 1 | 2 | 4 | 8, all handled above.
            assertNever(length);
    }
    return value;
}

/**
 * Decode a varint from the start of `buf`. Returns the value and the number of
 * bytes consumed. Throws RangeError if the buffer is too short to hold the
 * encoded varint.
 */
export function decodeVarint(buf: Bytes): DecodedVarint {
    if (buf.length === 0) {
        throw new RangeError("varint decode: empty buffer");
    }
    // buf.length > 0 guarantees buf[0] is defined; the non-null assertion
    // satisfies noUncheckedIndexedAccess without a dead defensive branch.
    const first = buf[0]!;
    const prefix = first >> 6;
    const length: VarintLength = (1 << prefix) as VarintLength; // 1, 2, 4, or 8
    if (buf.length < length) {
        throw new RangeError("varint decode: buffer too short");
    }
    // The length check above guarantees indices 0..length-1 are in bounds.
    // Provide a bounds-safe accessor so indexing needs no non-null assertion
    // under noUncheckedIndexedAccess.
    const at = (i: number): number => {
        const v = buf[i];
        return v ?? 0;
    };
    const value = readVarintPayload(at, length);
    return { value, length };
}
