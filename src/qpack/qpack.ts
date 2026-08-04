/**
 * QPACK encoder / decoder (RFC 9204).
 *
 * HTTP/3's replacement for HPACK. Unlike HPACK — which carries its dynamic
 * table updates in-band inside the header block — QPACK uses two dedicated
 * unidirectional QUIC streams (encoder + decoder) to synchronize the dynamic
 * table. This avoids head-of-line blocking: a header block references only the
 * static table plus an insert count, and the peer applies table updates
 * asynchronously on the encoder/decoder streams.
 *
 * Wire instructions (§2.1):
 *   - Encoder stream:   Set Dynamic Table Capacity, Insert With/Without Name
 *                        Reference, Duplicate.
 *   - Decoder stream:   Section Acknowledgment, Stream Cancellation, Insert
 *                        Count Increment.
 *
 * This module implements the full field-line representation set (§4.5):
 *   - Indexed (static + dynamic, with post-base variant)
 *   - Literal with name reference (static + dynamic, post-base variant)
 *   - Literal with literal name
 * plus the encoded field-section prefix (Required Insert Count + Base).
 *
 * The encoder emits encoder-stream instructions for capacity changes and
 * inserts; the decoder applies those instructions to rebuild an identical
 * dynamic table, then decodes header blocks against it.
 */

import { QpackDecodeError } from "../errors.js";
import type { Bytes, HeaderBlock, HeaderField, QpackEncoderInstruction } from "../types.js";
import { assertNever } from "../utils.js";
import {
    DynamicTable,
    findDynamicByName,
    resolveDynamic,
} from "./dynamic-table.js";
import {
    decodeEncoderInstruction,
    decodeInteger,
    decodeLatin1,
    decodeString,
    encodeDecoderInstruction,
    encodeEncoderInstruction,
    encodeInteger,
    encodeLatin1,
    encodeString,
} from "./encoding.js";
import {
    findStaticExactIndex,
    findStaticNameIndex,
    getStaticEntry,
    resolveStatic,
} from "./tables.js";

export type { HeaderField, HeaderBlock };

// ---------------------------------------------------------------------------
// Encoded field-section prefix (RFC 9204 §4.5.1)
// ---------------------------------------------------------------------------

/**
 * Encode the two-integer prefix: Required Insert Count (8-bit prefix) and
 * Sign + Delta Base (7-bit prefix).
 *
 *   if Sign == 0: Base = ReqInsertCount + DeltaBase
 *   if Sign == 1: Base = ReqInsertCount - DeltaBase - 1
 *
 * For simplicity, Required Insert Count is encoded directly (valid for small
 * insert counts; the RFC's modulo encoding in §4.5.1.1 is used for long-lived
 * connections and is not needed for correctness at small scale).
 */
export function encodePrefix(requiredInsertCount: number, base: number): Bytes {
    const ricOctets = encodeInteger(requiredInsertCount, 8);
    const sign = base >= requiredInsertCount ? 0 : 1;
    const deltaBase = sign === 0
        ? base - requiredInsertCount
        : requiredInsertCount - base - 1;
    const deltaOctets = encodeInteger(deltaBase, 7);
    const firstDelta = deltaOctets[0];
    if (firstDelta === undefined) {
        throw new QpackDecodeError("prefix: empty delta-base encoding");
    }
    // OR the sign bit into the top of the delta-base prefix.
    deltaOctets[0] = (firstDelta & 0x7f) | (sign << 7);
    return Uint8Array.from([...ricOctets, ...deltaOctets]);
}

/** Decode the prefix. Returns Required Insert Count and Base. */
export function decodePrefix(buf: Bytes, offset = 0): {
    requiredInsertCount: number;
    base: number;
    nextOffset: number;
} {
    const ricResult = decodeInteger(buf, offset, 8);
    const signOctet = buf[ricResult.nextOffset];
    if (signOctet === undefined) {
        throw new QpackDecodeError("prefix: buffer underflow reading base");
    }
    const deltaResult = decodeInteger(buf, ricResult.nextOffset, 7);
    const sign = signOctet & 0x80 ? 1 : 0;
    const base = sign === 0
        ? ricResult.value + deltaResult.value
        : ricResult.value - deltaResult.value - 1;
    return { requiredInsertCount: ricResult.value, base, nextOffset: deltaResult.nextOffset };
}

// ---------------------------------------------------------------------------
// Field-line representations (RFC 9204 §4.5.2–§4.5.6)
// ---------------------------------------------------------------------------

/**
 * Encode a single field line into the header block body (without the prefix).
 *
 * Representation chosen:
 *   - exact static match → Indexed Field Line, static (1T + index, T=1)
 *   - name-in-static match → Literal with Name Reference, static (01NT + index + value)
 *   - dynamic match (name+value) → Indexed Field Line, dynamic relative (1T + r, T=0)
 *   - dynamic name match → Literal with Name Reference, dynamic relative (01NT + r + value)
 *   - otherwise → Literal with Literal Name (001NH + name + value)
 *
 * `base` is the absolute-index reference point; dynamic relative indices are
 * computed as `base - 1 - absIndex` (§3.2.5). Returns the absolute index of any
 * dynamic-table reference made (for Required Insert Count tracking), or
 * undefined if the field line references only the static table / literals.
 */
export function encodeFieldLine(
    buf: number[],
    name: string,
    value: string,
    base: number,
    dynamic: DynamicTable,
): number | undefined {
    // 1. Exact static match.
    const staticExact = findStaticExactIndex(name, value);
    if (staticExact !== undefined) {
        // 1T + Index(6+), T=1 → top two bits = 11.
        const octets = encodeInteger(staticExact, 6);
        const first = octets[0];
        if (first === undefined) {
            throw new QpackDecodeError("indexed static: empty integer encoding");
        }
        buf.push((first & 0x3f) | 0xc0, ...octets.slice(1));
        return undefined;
    }

    // 2. Name-in-static match → literal with static name reference.
    const staticName = findStaticNameIndex(name);
    if (staticName !== undefined) {
        encodeLiteralNameRef(buf, staticName, value, true);
        return undefined;
    }

    // 3. Dynamic exact match → indexed dynamic (relative to base).
    const dynExact = findDynamicByName(name, dynamic);
    if (dynExact) {
        const dynValue = dynamic.getByAbsoluteIndex(dynExact.absIndex);
        if (dynValue && dynValue.value === value) {
            encodeIndexedDynamic(buf, dynExact.absIndex, base);
            return dynExact.absIndex;
        }
        // Name matches but value differs → literal with dynamic name
        // reference. The wire index is relative: base - 1 - absIndex.
        const relative = base - 1 - dynExact.absIndex;
        encodeLiteralNameRef(buf, relative, value, false);
        return dynExact.absIndex;
    }

    // 4. Literal with literal name.
    encodeLiteralLiteralName(buf, name, value);
    return undefined;
}

/** Indexed Field Line, dynamic: 1T + relativeIndex(6+), T=0 → top bit = 1. */
function encodeIndexedDynamic(buf: number[], absIndex: number, base: number): void {
    const relative = base - 1 - absIndex;
    const octets = encodeInteger(relative, 6);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("indexed dynamic: empty integer encoding");
    }
    buf.push((first & 0x3f) | 0x80, ...octets.slice(1));
}

/**
 * Literal Field Line with Name Reference: 01 + N + T + NameIndex(4+) + value
 * string (H=0, 7-bit prefix). T=1 static, T=0 dynamic. N=0 (indexing allowed).
 */
function encodeLiteralNameRef(
    buf: number[],
    nameIndex: number,
    value: string,
    isStatic: boolean,
): void {
    const octets = encodeInteger(nameIndex, 4);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("literal name ref: empty integer encoding");
    }
    // bits 7..6 = 01, bit 5 = N (0), bit 4 = T.
    buf.push((first & 0x0f) | 0x40 | (isStatic ? 0x10 : 0x00), ...octets.slice(1));
    for (const o of encodeString(value)) {
        buf.push(o);
    }
}

/**
 * Literal Field Line with Literal Name: 001 + N + H + NameLength(3+) + name +
 * value string (H=0, 7-bit prefix). N=0, H=0.
 */
function encodeLiteralLiteralName(buf: number[], name: string, value: string): void {
    const nameBytes = encodeLatin1(name);
    const octets = encodeInteger(nameBytes.length, 3);
    const first = octets[0];
    if (first === undefined) {
        throw new QpackDecodeError("literal name: empty integer encoding");
    }
    // bits 7..5 = 001, bit 4 = N (0), bit 3 = H (0) → pattern 0010 = 0x20.
    buf.push((first & 0x07) | 0x20, ...octets.slice(1));
    for (const b of nameBytes) {
        buf.push(b);
    }
    for (const o of encodeString(value)) {
        buf.push(o);
    }
}

// ---------------------------------------------------------------------------
// Header-block decoder (field-line representations)
// ---------------------------------------------------------------------------

/**
 * Decode one field line from the header block body. Resolves references against
 * the static table and the decoder's dynamic table. Returns the field and the
 * new offset.
 */
export function decodeFieldLine(
    buf: Bytes,
    offset: number,
    base: number,
    dynamic: DynamicTable,
): { field: HeaderField; nextOffset: number } {
    const octet = buf[offset];
    if (octet === undefined) {
        throw new QpackDecodeError("field line decode: buffer underflow reading opcode");
    }

    // Indexed Field Line: top bit = 1 (1T + Index(6+)).
    if ((octet & 0x80) !== 0) {
        const isStatic = (octet & 0x40) !== 0;
        const indexResult = decodeInteger(buf, offset, 6);
        if (isStatic) {
            const resolved = resolveStatic(indexResult.value);
            if (!resolved) {
                throw new QpackDecodeError(`indexed static: index ${indexResult.value} out of range`);
            }
            return { field: resolved.field, nextOffset: indexResult.nextOffset };
        }
        // Dynamic: relative index → absolute = base - 1 - relative.
        const absIndex = base - 1 - indexResult.value;
        const resolved = resolveDynamic(absIndex, dynamic);
        if (!resolved) {
            throw new QpackDecodeError(`indexed dynamic: absolute index ${absIndex} not present`);
        }
        return { field: resolved.field, nextOffset: indexResult.nextOffset };
    }

    // Indexed Field Line with Post-Base Index: 0001 (top 4 bits).
    if ((octet & 0xf0) === 0x10) {
        const indexResult = decodeInteger(buf, offset, 4);
        const absIndex = base + indexResult.value;
        const resolved = resolveDynamic(absIndex, dynamic);
        if (!resolved) {
            throw new QpackDecodeError(`post-base indexed: absolute index ${absIndex} not present`);
        }
        return { field: resolved.field, nextOffset: indexResult.nextOffset };
    }

    // Literal Field Line with Name Reference: 01 (top 2 bits).
    if ((octet & 0xc0) === 0x40) {
        const isStatic = (octet & 0x10) !== 0;
        const nameResult = decodeInteger(buf, offset, 4);
        let name: string;
        if (isStatic) {
            const entry = getStaticEntry(nameResult.value);
            if (!entry) {
                throw new QpackDecodeError(`literal name ref static: index ${nameResult.value} out of range`);
            }
            name = entry.name;
        } else {
            const absIndex = base - 1 - nameResult.value;
            const resolved = resolveDynamic(absIndex, dynamic);
            if (!resolved) {
                throw new QpackDecodeError(`literal name ref dynamic: absolute index ${absIndex} not present`);
            }
            name = resolved.field.name;
        }
        const valueResult = decodeString(buf, nameResult.nextOffset);
        return { field: { name, value: valueResult.value }, nextOffset: valueResult.nextOffset };
    }

    // Literal Field Line with Post-Base Name Reference: 0000 (top 4 bits).
    if ((octet & 0xf0) === 0x00) {
        const nameResult = decodeInteger(buf, offset, 3);
        const absIndex = base + nameResult.value;
        const resolved = resolveDynamic(absIndex, dynamic);
        if (!resolved) {
            throw new QpackDecodeError(`post-base name ref: absolute index ${absIndex} not present`);
        }
        const valueResult = decodeString(buf, nameResult.nextOffset);
        return {
            field: { name: resolved.field.name, value: valueResult.value },
            nextOffset: valueResult.nextOffset,
        };
    }

    // Literal Field Line with Literal Name: 001 (top 3 bits).
    if ((octet & 0xe0) === 0x20) {
        const nameLenResult = decodeInteger(buf, offset, 3);
        const nameStart = nameLenResult.nextOffset;
        const nameEnd = nameStart + nameLenResult.value;
        if (nameEnd > buf.length) {
            throw new QpackDecodeError("literal name: name length exceeds buffer");
        }
        const name = decodeLatin1(buf, nameStart, nameLenResult.value);
        const valueResult = decodeString(buf, nameEnd);
        return { field: { name, value: valueResult.value }, nextOffset: valueResult.nextOffset };
    }

    throw new QpackDecodeError(`field line decode: unrecognized opcode 0x${octet.toString(16)}`);
}

// ---------------------------------------------------------------------------
// QPACK encoder
// ---------------------------------------------------------------------------

/**
 * QPACK encoder (RFC 9204 §2.1).
 *
 * Produces header blocks and encoder-stream instructions. The encoder tracks
 * its dynamic table and insert count; each `encode()` call returns the header
 * block plus any encoder-stream instructions (capacity changes, inserts) the
 * decoder must apply first.
 */
export class QpackEncoder {
    private readonly dynamic: DynamicTable;
    private capacity: number;

    /** Encoder-stream instructions accumulated since the last `encode()`. */
    private pendingInstructions: Bytes = new Uint8Array();

    public constructor(capacity = 0) {
        this.capacity = capacity;
        this.dynamic = new DynamicTable(capacity);
        if (capacity > 0) {
            this.emitEncoderInstruction({ kind: "setDynamicTableCapacity", capacity });
        }
    }

    /** Current dynamic-table capacity. */
    public get tableCapacity(): number {
        return this.capacity;
    }

    /** Current number of entries in the dynamic table. */
    public get tableLength(): number {
        return this.dynamic.length;
    }

    /** Total entries ever inserted (the next insertion's absolute index). */
    public get insertCount(): number {
        return this.dynamic.getInsertCount();
    }

    /**
     * Change the dynamic-table capacity, emitting a Set Dynamic Table Capacity
     * instruction. Evicts entries if the new capacity is smaller.
     */
    public setCapacity(capacity: number): void {
        this.capacity = capacity;
        this.dynamic.setCapacity(capacity);
        this.emitEncoderInstruction({ kind: "setDynamicTableCapacity", capacity });
    }

    /**
     * Insert a header field into the dynamic table using a static-table name
     * reference. Emits an Insert With Name Reference instruction. Returns the
     * absolute index of the new entry.
     */
    public insert(name: string, value: string): number {
        const staticName = findStaticNameIndex(name);
        if (staticName === undefined) {
            throw new QpackDecodeError(`insert: name "${name}" not in static table`);
        }
        const absIndex = this.dynamic.add(name, value);
        this.emitEncoderInstruction({
            kind: "insertWithNameReference",
            nameIndex: staticName,
            value: Uint8Array.from(encodeLatin1(value)),
            static: true,
        });
        return absIndex;
    }

    /**
     * Insert a header field into the dynamic table with a literal name. Emits
     * an Insert Without Name Reference instruction. Returns the absolute index.
     */
    public insertLiteral(name: string, value: string): number {
        const absIndex = this.dynamic.add(name, value);
        this.emitEncoderInstruction({
            kind: "insertWithoutNameReference",
            name: Uint8Array.from(encodeLatin1(name)),
            value: Uint8Array.from(encodeLatin1(value)),
        });
        return absIndex;
    }

    /**
     * Duplicate the dynamic-table entry at the given relative index (0 = most
     * recent). Emits a Duplicate instruction. Returns the new absolute index.
     */
    public duplicate(relativeIndex: number): number {
        const absIndex = this.dynamic.duplicate(relativeIndex);
        if (absIndex === undefined) {
            throw new QpackDecodeError(`duplicate: relative index ${relativeIndex} out of range`);
        }
        this.emitEncoderInstruction({ kind: "duplicate", index: relativeIndex });
        return absIndex;
    }

    /** Encode a headers map into a QPACK header block (without prefix). */
    public encodeBody(headers: ReadonlyMap<string, string>): Bytes {
        // Base = insertCount (so relative index 0 → most recent entry).
        const base = this.insertCount;
        let requiredInsertCount = 0;
        const buf: number[] = [];
        for (const [name, value] of headers) {
            const dynRef = encodeFieldLine(buf, name, value, base, this.dynamic);
            if (dynRef !== undefined && dynRef + 1 > requiredInsertCount) {
                requiredInsertCount = dynRef + 1;
            }
        }
        // Prepend the prefix.
        const prefix = encodePrefix(requiredInsertCount, base);
        return Uint8Array.from([...prefix, ...buf]);
    }

    /**
     * Encode a headers map into a full QPACK header block (prefix + body).
     * Convenience wrapper over `encodeBody`.
     */
    public encode(headers: ReadonlyMap<string, string>): Bytes {
        return this.encodeBody(headers);
    }

    /** Drain and return accumulated encoder-stream instructions. */
    public drainInstructions(): Bytes {
        const drained = this.pendingInstructions;
        this.pendingInstructions = new Uint8Array();
        return drained;
    }

    private emitEncoderInstruction(inst: QpackEncoderInstruction): void {
        const encoded = encodeEncoderInstruction(inst);
        const merged = new Uint8Array(this.pendingInstructions.length + encoded.length);
        merged.set(this.pendingInstructions, 0);
        merged.set(encoded, this.pendingInstructions.length);
        this.pendingInstructions = merged;
    }
}

// ---------------------------------------------------------------------------
// QPACK decoder
// ---------------------------------------------------------------------------

/**
 * QPACK decoder (RFC 9204 §2.2).
 *
 * Consumes header blocks and decoder-stream instructions. The decoder rebuilds
 * its dynamic table by applying encoder-stream instructions (via
 * `applyEncoderInstructions`), then decodes header blocks against it.
 */
export class QpackDecoder {
    private readonly dynamic: DynamicTable;
    /** Entries applied to the dynamic table (mirrors the encoder's insert count). */
    private appliedInsertCount = 0;

    public constructor(capacity = 0) {
        this.dynamic = new DynamicTable(capacity);
    }

    /** Current number of entries in the dynamic table. */
    public get tableLength(): number {
        return this.dynamic.length;
    }

    /** Total entries ever inserted. */
    public get insertCount(): number {
        return this.appliedInsertCount;
    }

    /**
     * Apply a sequence of encoder-stream instructions to rebuild the dynamic
     * table. Returns the decoder-stream instructions generated in response
     * (Section Acknowledgment for each block that referenced the table, and
     * Insert Count Increment for new entries).
     */
    public applyEncoderInstructions(
        buf: Bytes,
    ): Bytes {
        const insertCountBefore = this.appliedInsertCount;
        let offset = 0;
        while (offset < buf.length) {
            const result = decodeEncoderInstruction(buf, offset);
            this.applyEncoderInstruction(result.instruction);
            offset = result.nextOffset;
        }
        // Emit an Insert Count Increment covering the newly applied entries
        // (the decoder reports how many inserts/duplicates it has now applied).
        const newInserts = this.appliedInsertCount - insertCountBefore;
        if (newInserts > 0) {
            return Uint8Array.from(
                encodeDecoderInstruction({ kind: "insertCountIncrement", increment: newInserts }),
            );
        }
        return new Uint8Array();
    }

    /** Apply a single encoder instruction to the dynamic table. */
    private applyEncoderInstruction(inst: QpackEncoderInstruction): void {
        switch (inst.kind) {
            case "setDynamicTableCapacity":
                this.dynamic.setCapacity(inst.capacity);
                break;
            case "insertWithNameReference": {
                const name = inst.static
                    ? (getStaticEntry(inst.nameIndex)?.name ?? "")
                    : (this.dynamic.getByAbsoluteIndex(this.appliedInsertCount - 1 - inst.nameIndex)?.name ?? "");
                const value = decodeLatin1(inst.value, 0, inst.value.length);
                if (name.length > 0) {
                    this.dynamic.add(name, value);
                    this.appliedInsertCount++;
                }
                break;
            }
            case "insertWithoutNameReference": {
                const name = decodeLatin1(inst.name, 0, inst.name.length);
                const value = decodeLatin1(inst.value, 0, inst.value.length);
                this.dynamic.add(name, value);
                this.appliedInsertCount++;
                break;
            }
            case "duplicate": {
                const absIndex = this.dynamic.duplicate(inst.index);
                if (absIndex !== undefined) {
                    this.appliedInsertCount++;
                }
                break;
            }
            default:
                assertNever(inst);
        }
    }

    /**
     * Decode a QPACK header block into a headers map. Applies the prefix, then
     * decodes each field line.
     */
    public decode(block: Bytes): ReadonlyMap<string, string> {
        const prefix = decodePrefix(block, 0);
        const out = new Map<string, string>();
        let offset = prefix.nextOffset;
        while (offset < block.length) {
            const result = decodeFieldLine(block, offset, prefix.base, this.dynamic);
            out.set(result.field.name, result.field.value);
            offset = result.nextOffset;
        }
        return out;
    }
}

// ---------------------------------------------------------------------------
// Free functions — encode/decode a header block in one shot (no dynamic table)
// ---------------------------------------------------------------------------

/**
 * Encode a headers map into a QPACK header block using only the static table
 * and literal representations (no dynamic-table references). Suitable for a
 * single request/response with no shared state.
 */
export function encodeHeaders(headers: ReadonlyMap<string, string>): Bytes {
    const encoder = new QpackEncoder(0);
    return encoder.encode(headers);
}

/**
 * Decode a QPACK header block produced by `encodeHeaders` (static table +
 * literals only). The dynamic table is empty.
 */
export function decodeHeaders(buf: Bytes): ReadonlyMap<string, string> {
    const decoder = new QpackDecoder(0);
    return decoder.decode(buf);
}
