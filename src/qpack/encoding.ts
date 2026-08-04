/**
 * QPACK wire encoding (RFC 9204 §4).
 *
 * Three layers, bottom to top:
 *   1. Primitives — prefixed integers (§4.1.1) and string literals (§4.1.2).
 *   2. Encoder-stream instructions (§4.3) — capacity, inserts, duplicate.
 *   3. Decoder-stream instructions (§4.4) — section ack, stream cancel,
 *      insert-count increment.
 *
 * String literals here are emitted without Huffman coding (H=0); the decoder
 * accepts both H=0 and H=1 but only literal (H=0) strings are produced, keeping
 * the codec deterministic and side-effect free. Huffman decoding is intentionally
 * out of scope (the static Huffman table is large and orthogonal to the dynamic
 * table / wire-instruction behavior this module exists to test).
 */

import { QpackDecodeError } from "../errors.js";
import type {
    Bytes,
    QpackDecoderInstruction,
    QpackEncoderInstruction,
} from "../types.js";

// ---------------------------------------------------------------------------
// Prefixed integer encoding (RFC 9204 §4.1.1, identical to HPACK §5.1)
// ---------------------------------------------------------------------------

/**
 * Encode `value` using an N-bit prefix. Returns the octets (the prefix octet
 * carries no flag bits — callers OR those in themselves). Throws on
 * negative / non-integer input.
 */
export function encodeInteger(value: number, prefixBits: number): number[] {
    if (value < 0 || !Number.isInteger(value)) {
        throw new QpackDecodeError(`integer encode: value must be a non-negative integer, got ${value}`);
    }
    const maxPrefix = (1 << prefixBits) - 1;
    const out: number[] = [];
    if (value < maxPrefix) {
        out.push(value);
        return out;
    }
    // Prefix filled with the sentinel; the remainder is always encoded as one
    // or more continuation octets — even when it is zero.
    out.push(maxPrefix);
    let remaining = value - maxPrefix;
    while (true) {
        const octet = remaining % 128;
        remaining = Math.floor(remaining / 128);
        if (remaining > 0) {
            out.push(octet | 0x80);
        } else {
            out.push(octet);
            break;
        }
    }
    return out;
}

/** The result of decoding an integer: the value and the offset of the next byte. */
export interface DecodedInteger {
    readonly value: number;
    readonly nextOffset: number;
}

/** Read an integer starting at `buf[offset]` with an N-bit prefix. */
export function decodeInteger(buf: Bytes, offset: number, prefixBits: number): DecodedInteger {
    const firstOctet = buf[offset];
    if (firstOctet === undefined) {
        throw new QpackDecodeError("integer decode: buffer underflow reading first octet");
    }
    const maxPrefix = (1 << prefixBits) - 1;
    const first = firstOctet & maxPrefix;
    let position = offset + 1;
    if (first < maxPrefix) {
        return { value: first, nextOffset: position };
    }
    let value = maxPrefix;
    let shift = 0;
    while (position < buf.length) {
        const octet = buf[position];
        if (octet === undefined) {
            throw new QpackDecodeError("integer decode: buffer underflow in continuation octets");
        }
        value += (octet & 0x7f) * 2 ** shift;
        position++;
        shift += 7;
        if ((octet & 0x80) === 0) {
            return { value, nextOffset: position };
        }
    }
    throw new QpackDecodeError("integer decode: buffer underflow in continuation octets");
}

// ---------------------------------------------------------------------------
// String literals (RFC 9204 §4.1.2) — H=0 (literal) only
// ---------------------------------------------------------------------------

/** Encode a JS string into ISO-8859-1 bytes (each char must fit in 8 bits). */
export function encodeLatin1(s: string): Bytes {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        const code = s.codePointAt(i);
        if (code === undefined || code > 0xff) {
            throw new QpackDecodeError(`string encode: non-latin1 character at offset ${i}: U+${(code ?? 0).toString(16)}`);
        }
        out[i] = code;
    }
    return out;
}

/** Decode ISO-8859-1 bytes into a JS string. */
export function decodeLatin1(buf: Bytes, offset: number, length: number): string {
    let out = "";
    const end = offset + length;
    for (let i = offset; i < end; i++) {
        out += String.fromCodePoint(buf[i] ?? 0);
    }
    return out;
}

/** The result of decoding a length-prefixed string: value + next byte offset. */
export interface DecodedString {
    readonly value: string;
    readonly nextOffset: number;
}

/**
 * Encode a string literal with a 7-bit length prefix and H=0 (no Huffman).
 * Returns the octets including the length prefix.
 */
export function encodeString(value: string): number[] {
    const bytes = encodeLatin1(value);
    const lengthOctets = encodeInteger(bytes.length, 7);
    const first = lengthOctets[0];
    if (first === undefined) {
        throw new QpackDecodeError("string encode: empty length prefix");
    }
    // H=0: leave the high bit clear.
    lengthOctets[0] = first & 0x7f;
    return [...lengthOctets, ...bytes];
}

/**
 * Decode a length-prefixed string (§4.1.2). The high bit of the length prefix
 * is the Huffman flag: H=0 literal octets, H=1 Huffman-encoded (rejected here).
 */
export function decodeString(buf: Bytes, offset: number): DecodedString {
    const flagOctet = buf[offset];
    if (flagOctet === undefined) {
        throw new QpackDecodeError("string decode: buffer underflow reading length prefix");
    }
    const huffmanFlag = (flagOctet & 0x80) !== 0;
    const lengthResult = decodeInteger(buf, offset, 7);
    const length = lengthResult.value;
    const dataStart = lengthResult.nextOffset;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) {
        throw new QpackDecodeError(`string decode: length ${length} exceeds buffer (offset ${dataStart}, buffer ${buf.length})`);
    }
    if (huffmanFlag) {
        throw new QpackDecodeError("string decode: Huffman-encoded strings are not supported");
    }
    const value = decodeLatin1(buf, dataStart, length);
    return { value, nextOffset: dataEnd };
}

// ---------------------------------------------------------------------------
// Encoder-stream instructions (RFC 9204 §4.3)
// ---------------------------------------------------------------------------

/**
 * Encode a single encoder instruction to wire bytes.
 *
 *   Set Dynamic Table Capacity : 001 + Capacity(5+)
 *   Insert With Name Reference : 1 + T + NameIndex(6+) + H ValueLength(7+) Value
 *   Insert Without Name Ref    : 01 + H NameLength(5+) Name + H ValueLength(7+) Value
 *   Duplicate                  : 000 + Index(5+)
 */
export function encodeEncoderInstruction(inst: QpackEncoderInstruction): Bytes {
    switch (inst.kind) {
        case "setDynamicTableCapacity":
            return encodeSetDynamicTableCapacity(inst.capacity);
        case "insertWithNameReference":
            return encodeInsertWithNameReference(inst.nameIndex, inst.value, inst.static);
        case "insertWithoutNameReference":
            return encodeInsertWithoutNameReference(inst.name, inst.value);
        case "duplicate":
            return encodeDuplicate(inst.index);
        default: {
            // Exhaustiveness guard — instruction kinds are a closed set.
            throw new QpackDecodeError(`encoder instruction: unknown kind ${(inst as { kind: string }).kind}`);
        }
    }
}

/** Set Dynamic Table Capacity: 001 (3-bit pattern) + Capacity (5-bit prefix). */
export function encodeSetDynamicTableCapacity(capacity: number): Bytes {
    const octets = encodeInteger(capacity, 5);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("set capacity: empty integer encoding");
    }
    // OR in the 001 pattern (bits 7..5).
    octets[0] = (first & 0x1f) | 0x20;
    return Uint8Array.from(octets);
}

/**
 * Insert With Name Reference: 1 + T + NameIndex(6+) + value string (H=0,
 * 7-bit prefix). T=1 → static table, T=0 → dynamic table.
 */
export function encodeInsertWithNameReference(
    nameIndex: number,
    value: Bytes,
    isStatic: boolean,
): Bytes {
    const octets = encodeInteger(nameIndex, 6);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("insert with name ref: empty integer encoding");
    }
    // Bit 7 = 1, bit 6 = T.
    octets[0] = (first & 0x3f) | 0x80 | (isStatic ? 0x40 : 0x00);
    const valueOctets = encodeStringLatin1Bytes(value);
    return Uint8Array.from([...octets, ...valueOctets]);
}

/**
 * Insert Without Name Reference: 01 + name string (H=0, 5-bit prefix) + value
 * string (H=0, 7-bit prefix).
 */
export function encodeInsertWithoutNameReference(name: Bytes, value: Bytes): Bytes {
    const octets: number[] = [];
    // First octet: 01 pattern (bits 7..6) + top 5 bits of the name length.
    const nameLenOctets = encodeInteger(name.length, 5);
    const first = nameLenOctets[0];
    if (first === undefined) {
        throw new QpackDecodeError("insert without name ref: empty name-length encoding");
    }
    octets.push((first & 0x1f) | 0x40);
    // Any continuation octets of the name-length integer.
    for (let i = 1; i < nameLenOctets.length; i++) {
        octets.push(nameLenOctets[i] ?? 0);
    }
    // Name bytes (H=0 — the H bit is bit 5, which is part of the 5-bit prefix;
    // for H=0 the high bit of that prefix byte is the pattern's LSB, already
    // handled above). Then the value string with a 7-bit prefix.
    for (const b of name) {
        octets.push(b);
    }
    const valueOctets = encodeStringLatin1Bytes(value);
    for (const b of valueOctets) {
        octets.push(b);
    }
    return Uint8Array.from(octets);
}

/** Duplicate: 000 (3-bit pattern) + relative Index (5-bit prefix). */
export function encodeDuplicate(relativeIndex: number): Bytes {
    const octets = encodeInteger(relativeIndex, 5);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("duplicate: empty integer encoding");
    }
    // 000 pattern leaves the top 3 bits clear — nothing to OR in.
    octets[0] = first & 0x1f;
    return Uint8Array.from(octets);
}

/**
 * Encode a value as a 7-bit-prefix length-prefixed string (H=0) directly from
 * raw bytes — used for instruction values where the caller already has bytes.
 */
function encodeStringLatin1Bytes(value: Bytes): number[] {
    const lengthOctets = encodeInteger(value.length, 7);
    const first = lengthOctets[0];
    if (first === undefined) {
        throw new QpackDecodeError("value string: empty length prefix");
    }
    // H=0: leave the high bit clear.
    lengthOctets[0] = first & 0x7f;
    return [...lengthOctets, ...value];
}

/** The result of decoding one encoder instruction. */
export interface DecodedEncoder {
    readonly instruction: QpackEncoderInstruction;
    readonly nextOffset: number;
}

/** Decode one encoder instruction from the wire. */
export function decodeEncoderInstruction(buf: Bytes, offset = 0): DecodedEncoder {
    const octet = buf[offset];
    if (octet === undefined) {
        throw new QpackDecodeError("encoder decode: buffer underflow reading opcode");
    }
    // Set Dynamic Table Capacity: 001 pattern (top 3 bits = 001).
    if ((octet & 0xe0) === 0x20) {
        const result = decodeInteger(buf, offset, 5);
        return {
            instruction: { kind: "setDynamicTableCapacity", capacity: result.value },
            nextOffset: result.nextOffset,
        };
    }
    // Insert With Name Reference: top bit = 1.
    if ((octet & 0x80) !== 0) {
        const isStatic = (octet & 0x40) !== 0;
        const nameResult = decodeInteger(buf, offset, 6);
        const valueResult = decodeString(buf, nameResult.nextOffset);
        return {
            instruction: {
                kind: "insertWithNameReference",
                nameIndex: nameResult.value,
                value: Uint8Array.from(encodeLatin1(valueResult.value)),
                static: isStatic,
            },
            nextOffset: valueResult.nextOffset,
        };
    }
    // Insert Without Name Reference: top 2 bits = 01.
    if ((octet & 0xc0) === 0x40) {
        const nameLenResult = decodeInteger(buf, offset, 5);
        const nameStart = nameLenResult.nextOffset;
        const nameEnd = nameStart + nameLenResult.value;
        if (nameEnd > buf.length) {
            throw new QpackDecodeError("insert without name ref: name length exceeds buffer");
        }
        const name = buf.subarray(nameStart, nameEnd);
        const valueResult = decodeString(buf, nameEnd);
        return {
            instruction: {
                kind: "insertWithoutNameReference",
                name,
                value: Uint8Array.from(encodeLatin1(valueResult.value)),
            },
            nextOffset: valueResult.nextOffset,
        };
    }
    // Duplicate: top 3 bits = 000.
    if ((octet & 0xe0) === 0x00) {
        const result = decodeInteger(buf, offset, 5);
        return {
            instruction: { kind: "duplicate", index: result.value },
            nextOffset: result.nextOffset,
        };
    }
    throw new QpackDecodeError(`encoder decode: unrecognized opcode 0x${octet.toString(16)}`);
}

// ---------------------------------------------------------------------------
// Decoder-stream instructions (RFC 9204 §4.4)
// ---------------------------------------------------------------------------

/**
 * Encode a single decoder instruction to wire bytes.
 *
 *   Section Acknowledgment : 1 + StreamID(7+)
 *   Stream Cancellation     : 01 + StreamID(6+)
 *   Insert Count Increment  : 00 + Increment(6+)
 */
export function encodeDecoderInstruction(inst: QpackDecoderInstruction): Bytes {
    switch (inst.kind) {
        case "sectionAcknowledgment":
            return encodeSectionAcknowledgment(inst.streamId);
        case "streamCancellation":
            return encodeStreamCancellation(inst.streamId);
        case "insertCountIncrement":
            return encodeInsertCountIncrement(inst.increment);
        default: {
            throw new QpackDecodeError(`decoder instruction: unknown kind ${(inst as { kind: string }).kind}`);
        }
    }
}

/** Section Acknowledgment: 1 (1-bit pattern) + StreamID (7-bit prefix). */
export function encodeSectionAcknowledgment(streamId: bigint): Bytes {
    const octets = encodeInteger(Number(streamId), 7);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("section ack: empty integer encoding");
    }
    octets[0] = (first & 0x7f) | 0x80;
    return Uint8Array.from(octets);
}

/** Stream Cancellation: 01 (2-bit pattern) + StreamID (6-bit prefix). */
export function encodeStreamCancellation(streamId: bigint): Bytes {
    const octets = encodeInteger(Number(streamId), 6);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("stream cancel: empty integer encoding");
    }
    octets[0] = (first & 0x3f) | 0x40;
    return Uint8Array.from(octets);
}

/** Insert Count Increment: 00 (2-bit pattern) + Increment (6-bit prefix). */
export function encodeInsertCountIncrement(increment: number): Bytes {
    const octets = encodeInteger(increment, 6);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("insert count increment: empty integer encoding");
    }
    // 00 pattern leaves the top 2 bits clear.
    octets[0] = first & 0x3f;
    return Uint8Array.from(octets);
}

/** The result of decoding one decoder instruction. */
export interface DecodedDecoder {
    readonly instruction: QpackDecoderInstruction;
    readonly nextOffset: number;
}

/** Decode one decoder instruction from the wire. */
export function decodeDecoderInstruction(buf: Bytes, offset = 0): DecodedDecoder {
    const octet = buf[offset];
    if (octet === undefined) {
        throw new QpackDecodeError("decoder decode: buffer underflow reading opcode");
    }
    // Section Acknowledgment: top bit = 1.
    if ((octet & 0x80) !== 0) {
        const result = decodeInteger(buf, offset, 7);
        return {
            instruction: { kind: "sectionAcknowledgment", streamId: BigInt(result.value) },
            nextOffset: result.nextOffset,
        };
    }
    // Stream Cancellation: top 2 bits = 01.
    if ((octet & 0xc0) === 0x40) {
        const result = decodeInteger(buf, offset, 6);
        return {
            instruction: { kind: "streamCancellation", streamId: BigInt(result.value) },
            nextOffset: result.nextOffset,
        };
    }
    // Insert Count Increment: top 2 bits = 00.
    if ((octet & 0xc0) === 0x00) {
        const result = decodeInteger(buf, offset, 6);
        return {
            instruction: { kind: "insertCountIncrement", increment: result.value },
            nextOffset: result.nextOffset,
        };
    }
    throw new QpackDecodeError(`decoder decode: unrecognized opcode 0x${octet.toString(16)}`);
}
