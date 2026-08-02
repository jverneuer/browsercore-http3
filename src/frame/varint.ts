/**
 * QUIC variable-length integer encoding (RFC 9000 §16).
 *
 * Used for stream ids, frame types, frame lengths, SETTINGS ids/values, and
 * push ids throughout HTTP/3. Two-bit prefix selects the length: 1, 2, 4, or
 * 8 bytes.
 *
 * TODO (Step 1 of PLAN.md): implement encodeVarint / decodeVarint.
 */

import { VARINT_MAX, type Bytes } from "../types.js";

/** A varint that has been decoded from the wire, plus the bytes it occupied. */
export interface DecodedVarint {
    readonly value: bigint;
    readonly length: number;
}

/** Return the number of bytes needed to encode `value` as a varint. */
export function getVarintEncodedLength(value: bigint): number {
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

/** Encode a varint to its wire representation. */
export function encodeVarint(value: bigint): Bytes {
    void value;
    throw new Error("TODO: implement encodeVarint (Step 1)");
}

/**
 * Decode a varint from the start of `buf`. Returns the value and the number of
 * bytes consumed. Throws RangeError if the buffer is too short.
 */
export function decodeVarint(buf: Bytes): DecodedVarint {
    void buf;
    throw new Error("TODO: implement decodeVarint (Step 1)");
}
