/**
 * QPACK: Field Compression for HTTP/3 (RFC 9204).
 *
 * Two wire layers:
 *   1. Field-line representations — encode/decode header blocks against the
 *      static table and a shared dynamic table (§3, §4.5).
 *   2. Wire instructions — synchronize the dynamic table over the two
 *      unidirectional QPACK streams (§4.3, §4.4).
 *
 * Field-line representations (§4.5):
 *   - Indexed:            1 T <Index 6+>            (T=1 static, T=0 dynamic)
 *   - Post-Base Indexed:  0001 <Index 4+>
 *   - Literal name ref:   01 N T <NameIdx 4+>  <value>
 *   - Post-Base name ref: 0000 N <NameIdx 3+>  <value>
 *   - Literal name:       001 N H <NameLen 3+>  <name> <value>
 *
 * This implementation always emits H=0 (no Huffman) string literals and
 * decodes H=0 literals. Huffman encoding is optional in QPACK and omitted
 * here for deterministic, testable output.
 */

import type { Bytes, HeaderField, HeaderBlock } from "../types.js";
import { QpackDecodeError } from "../errors.js";
import { STATIC_TABLE } from "./tables.js";
import { QpackDynamicTable } from "./dynamic-table.js";
import {
    ByteReader,
    ByteWriter,
    readPrefixedInt,
    readStringLiteral,
    readTaggedStringLiteral,
    writePrefixedInt,
    writePrefixedIntWithBase,
    writeStringLiteral,
} from "./encoding.js";

export type { HeaderField, HeaderBlock };

// ---------------------------------------------------------------------------
// Static-table lookups
// ---------------------------------------------------------------------------

/** Index of the full (name, value) in the static table, or -1. */
function findStaticField(name: string, value: string): number {
    for (let i = 0; i < STATIC_TABLE.length; i += 1) {
        const entry = STATIC_TABLE[i]!;
        if (entry.name === name && entry.value === value) {
            return i;
        }
    }
    return -1;
}

/** Index of a field name (any value) in the static table, or -1. */
function findStaticName(name: string): number {
    for (let i = 0; i < STATIC_TABLE.length; i += 1) {
        if (STATIC_TABLE[i]!.name === name) {
            return i;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Public API: static-table-only header block encode/decode (Step 3)
// ---------------------------------------------------------------------------

/**
 * Encode a header map into a QPACK header block using only the static table.
 *
 * The block prefix uses Required Insert Count = 0 and Base = 0 (no dynamic
 * table references), which is always decodable. Field lines are emitted in
 * map-insertion order. Representation choice per field line:
 *   1. static indexed reference (whole line matches), else
 *   2. static name reference + literal value, else
 *   3. full literal name + value.
 */
export function encodeHeaders(headers: ReadonlyMap<string, string>): Bytes {
    const writer = new ByteWriter();
    writer.write(0x00); // Required Insert Count = 0 (8-bit prefix)
    writer.write(0x00); // S=0, Delta Base = 0 (7-bit prefix)
    for (const [name, value] of headers) {
        encodeStaticFieldLine(writer, name, value);
    }
    return writer.toBytes();
}

/** Encode one field line against the static table only. */
function encodeStaticFieldLine(writer: ByteWriter, name: string, value: string): void {
    const fullIndex = findStaticField(name, value);
    if (fullIndex !== -1) {
        // Indexed Field Line, static: 1 1 <index 6+>
        writePrefixedInt(writer, 0x80 | fullIndex, 6);
        return;
    }
    const nameIndex = findStaticName(name);
    if (nameIndex !== -1) {
        // Literal with Name Reference, static: 0 1 0 1 <nameIndex 4+>
        writePrefixedInt(writer, 0x50 | nameIndex, 4);
        writeStringLiteral(writer, value);
        return;
    }
    // Literal with Literal Name: 0 0 1 0 <name> <value> (N=0, H=0).
    writePrefixedInt(writer, 0x20, 3);
    writeStringLiteral(writer, name);
    writeStringLiteral(writer, value);
}

/**
 * Decode a header block that uses only the static table (RIC=0) into a header
 * map. Field lines are decoded in order; duplicate names overwrite earlier
 * values (callers requiring multi-value handling can decode to a list).
 */
export function decodeHeaders(buf: Bytes): ReadonlyMap<string, string> {
    const reader = new ByteReader(buf);
    readPrefixedInt(reader, 8); // Required Insert Count (ignored; static-only)
    readPrefixedInt(reader, 7); // S + Delta Base (ignored)
    const out = new Map<string, string>();
    while (reader.remaining > 0) {
        const field = readRepresentation(reader);
        out.set(field.name, field.value);
    }
    return out;
}

/** Read one field-line representation (static-table references only). */
function readRepresentation(reader: ByteReader): HeaderField {
    const first = reader.peek();
    if ((first & 0x80) !== 0) {
        return decodeStaticIndexed(reader);
    }
    if ((first & 0x40) !== 0) {
        return decodeStaticLiteralNameRef(reader);
    }
    return decodeLiteralLiteral(reader);
}

/** Decode an Indexed Field Line referencing the static table. */
function decodeStaticIndexed(reader: ByteReader): HeaderField {
    const value = readPrefixedInt(reader, 6);
    const entry = STATIC_TABLE[value];
    if (entry === undefined) {
        throw new QpackDecodeError(`indexed field line: invalid static index ${value}`);
    }
    return { name: entry.name, value: entry.value };
}

/** Decode a Literal Field Line with static Name Reference. */
function decodeStaticLiteralNameRef(reader: ByteReader): HeaderField {
    const nameIndex = readPrefixedInt(reader, 4);
    const entry = STATIC_TABLE[nameIndex];
    if (entry === undefined) {
        throw new QpackDecodeError(`literal name ref: invalid static index ${nameIndex}`);
    }
    const value = readStringLiteral(reader);
    return { name: entry.name, value };
}

/** Decode a Literal Field Line with Literal Name. */
function decodeLiteralLiteral(reader: ByteReader): HeaderField {
    readPrefixedInt(reader, 3); // 0 0 1 N H prefix (consumed)
    const name = readStringLiteral(reader);
    const value = readStringLiteral(reader);
    return { name, value };
}

// ---------------------------------------------------------------------------
// Dynamic-table-aware encoder / decoder (Step 4)
// ---------------------------------------------------------------------------

/**
 * QPACK encoder: produces header blocks and the encoder-stream instructions
 * that keep the peer's dynamic table in sync.
 *
 * Strategy: for each field line, if it already exists in the dynamic table,
 * reference it (relative index). Otherwise insert it by literal name on the
 * encoder stream and reference it with a post-base index. This is a correct
 * single-pass approach (RFC 9204 §4.5.1.2, Appendix C).
 */
export class QpackEncoder {
    private readonly table = new QpackDynamicTable(0);

    /** Apply SETTINGS_QPACK_MAX_TABLE_CAPACITY from the peer. */
    public applyMaxCapacity(maxCapacity: number): void {
        this.table.setCapacity(maxCapacity);
    }

    /** Total entries inserted over the lifetime (Insert Count). */
    public get insertCount(): number {
        return this.table.insertCount;
    }

    /**
     * Encode a header block. Returns the block bytes, the Required Insert
     * Count, and the encoder-stream instruction bytes that must be sent before
     * the block is decoded.
     */
    public encode(headers: ReadonlyMap<string, string>): {
        block: Bytes;
        requiredInsertCount: number;
        encoderBytes: Bytes;
    } {
        const blockWriter = new ByteWriter();
        const encWriter = new ByteWriter();
        const base = this.table.insertCount;
        let requiredInsertCount = 0;

        for (const [name, value] of headers) {
            const existing = this.findDynamic(name, value);
            if (existing !== -1) {
                // Reference the existing dynamic entry by relative index.
                const relative = base - 1 - existing;
                writeDynamicIndexRef(blockWriter, relative);
                requiredInsertCount = Math.max(requiredInsertCount, existing + 1);
            } else {
                // Insert by literal name on the encoder stream, then reference
                // post-base in the block.
                writeInsertLiteralName(encWriter, name, value);
                this.table.insert(name, value);
                const postBase = this.table.insertCount - base - 1;
                writePostBaseIndexRef(blockWriter, postBase);
                requiredInsertCount = this.table.insertCount;
            }
        }

        writeBlockPrefix(blockWriter, requiredInsertCount, base);
        return {
            block: blockWriter.toBytes(),
            requiredInsertCount,
            encoderBytes: encWriter.toBytes(),
        };
    }

    /** Find the absolute index of a matching dynamic entry (newest-first), or -1. */
    private findDynamic(name: string, value: string): number {
        for (let i = this.table.length - 1; i >= 0; i -= 1) {
            const entry = this.table.at(i);
            if (entry !== undefined && entry.name === name && entry.value === value) {
                return entry.absoluteIndex;
            }
        }
        return -1;
    }
}

/**
 * QPACK decoder: decodes header blocks and emits decoder-stream instructions.
 *
 * Tracks the Insert Count and emits Section Acknowledgment / Stream
 * Cancellation / Insert Count Increment instructions.
 */
export class QpackDecoder {
    private readonly table = new QpackDynamicTable(0);
    private pendingInserts = 0;

    /** Apply SETTINGS_QPACK_MAX_TABLE_CAPACITY advertised to the encoder. */
    public applyMaxCapacity(maxCapacity: number): void {
        this.table.setCapacity(maxCapacity);
    }

    /** Current Insert Count. */
    public get insertCount(): number {
        return this.table.insertCount;
    }

    /**
     * Decode a header block given its Required Insert Count. Resolves static
     * and dynamic-table references against the current table state. Throws
     * QpackDecodeError if the block references dynamic entries not yet
     * received (Required Insert Count > Insert Count).
     */
    public decode(buf: Bytes, requiredInsertCount: number): ReadonlyMap<string, string> {
        if (requiredInsertCount > this.table.insertCount) {
            throw new QpackDecodeError(
                `blocked: required ${requiredInsertCount} > have ${this.table.insertCount}`,
            );
        }
        const reader = new ByteReader(buf);
        readPrefixedInt(reader, 8); // Required Insert Count
        const base = this.readBase(reader);
        const out = new Map<string, string>();
        while (reader.remaining > 0) {
            const field = this.readRepresentation(reader, base);
            out.set(field.name, field.value);
        }
        return out;
    }

    /** Read the S + Delta Base field and resolve the absolute Base (§4.5.1.2). */
    private readBase(reader: ByteReader): number {
        const first = reader.read();
        const sign = (first & 0x80) !== 0;
        let deltaBase = first & 0x7f;
        const max = (1 << 7) - 1;
        if (deltaBase === max) {
            let m = 0;
            let byte = 0;
            do {
                byte = reader.read();
                deltaBase += (byte & 0x7f) * (1 << m);
                m += 7;
            } while ((byte & 0x80) !== 0);
        }
        // Base relative to the Required Insert Count (== insertCount here).
        const ric = this.table.insertCount;
        return sign ? ric - deltaBase - 1 : ric + deltaBase;
    }

    /** Read one field-line representation, resolving dynamic refs against `base`. */
    private readRepresentation(reader: ByteReader, base: number): HeaderField {
        const first = reader.peek();
        if ((first & 0x80) !== 0) {
            return this.decodeIndexed(reader, base);
        }
        if ((first & 0x40) !== 0) {
            return this.decodeLiteralNameRef(reader, base);
        }
        return decodeLiteralLiteral(reader);
    }

    /** Decode an Indexed Field Line (static or dynamic, relative to base). */
    private decodeIndexed(reader: ByteReader, base: number): HeaderField {
        const value = readPrefixedInt(reader, 6);
        const t = (value >> 5) & 1;
        const index = value & 0x1f;
        if (t === 1) {
            const entry = STATIC_TABLE[index];
            if (entry === undefined) {
                throw new QpackDecodeError(`indexed field line: invalid static index ${index}`);
            }
            return { name: entry.name, value: entry.value };
        }
        // Dynamic relative index: absolute = base - 1 - index.
        const absolute = base - 1 - index;
        const entry = this.table.getByAbsoluteIndex(absolute);
        if (entry === undefined) {
            throw new QpackDecodeError(`indexed field line: invalid dynamic index ${index}`);
        }
        return { name: entry.name, value: entry.value };
    }

    /** Decode a Literal Field Line with Name Reference (static or dynamic). */
    private decodeLiteralNameRef(reader: ByteReader, base: number): HeaderField {
        const nameIndex = readPrefixedInt(reader, 4);
        const t = (nameIndex >> 3) & 1;
        const index = nameIndex & 0x07;
        const value = readStringLiteral(reader);
        if (t === 1) {
            const entry = STATIC_TABLE[index];
            if (entry === undefined) {
                throw new QpackDecodeError(`literal name ref: invalid static index ${index}`);
            }
            return { name: entry.name, value };
        }
        const absolute = base - 1 - index;
        const entry = this.table.getByAbsoluteIndex(absolute);
        if (entry === undefined) {
            throw new QpackDecodeError(`literal name ref: invalid dynamic index ${index}`);
        }
        return { name: entry.name, value };
    }

    /**
     * Consume encoder-stream bytes: apply Set Capacity / Insert / Duplicate
     * instructions. Returns the number of new inserts applied (so the caller
     * can emit Insert Count Increment instructions).
     */
    public consumeEncoderStream(buf: Bytes): number {
        const reader = new ByteReader(buf);
        const before = this.table.insertCount;
        while (reader.remaining > 0) {
            readEncoderInstruction(reader, this.table);
        }
        this.pendingInserts += this.table.insertCount - before;
        return this.table.insertCount - before;
    }

    /** Emit an Insert Count Increment instruction for received inserts. */
    public emitInsertCountIncrement(): Bytes {
        const writer = new ByteWriter();
        writePrefixedInt(writer, this.pendingInserts, 6);
        this.pendingInserts = 0;
        return writer.toBytes();
    }

    /** Emit a Section Acknowledgment instruction for a stream. */
    public emitSectionAcknowledgment(streamId: bigint): Bytes {
        const writer = new ByteWriter();
        writePrefixedInt(writer, Number(streamId), 7);
        return writer.toBytes();
    }

    /** Emit a Stream Cancellation instruction for a stream. */
    public emitStreamCancellation(streamId: bigint): Bytes {
        const writer = new ByteWriter();
        writePrefixedInt(writer, Number(streamId), 6);
        return writer.toBytes();
    }
}

// ---------------------------------------------------------------------------
// Block prefix and field-line writers
// ---------------------------------------------------------------------------

/** Write the 2-byte encoded field section prefix (§4.5.1). */
function writeBlockPrefix(writer: ByteWriter, requiredInsertCount: number, base: number): void {
    // Required Insert Count with 8-bit prefix (simplified: assume < 2^8).
    writePrefixedInt(writer, requiredInsertCount, 8);
    // Base: S=0 (base >= RIC), DeltaBase = base - requiredInsertCount.
    const deltaBase = base >= requiredInsertCount ? base - requiredInsertCount : 0;
    const sign = base >= requiredInsertCount ? 0 : 0x80;
    writePrefixedInt(writer, sign | deltaBase, 7);
}

/** Write a dynamic-table relative-index reference: 1 0 <relative 6+>. */
function writeDynamicIndexRef(writer: ByteWriter, relative: number): void {
    writePrefixedInt(writer, 0x80 | relative, 6);
}

/** Write a post-base index reference: 0001 <postBase 4+>. */
function writePostBaseIndexRef(writer: ByteWriter, postBase: number): void {
    writePrefixedInt(writer, 0x10 | postBase, 4);
}

// ---------------------------------------------------------------------------
// Wire instructions (encoder + decoder streams)
// ---------------------------------------------------------------------------

/** Write an Insert-With-Literal-Name encoder instruction: 01 <name> <value>. */
function writeInsertLiteralName(writer: ByteWriter, name: string, value: string): void {
    const nameBytes = new TextEncoder().encode(name);
    // §4.3.3: 01 H <Name Length 5+>; H=0 → base 0b010_00000 = 0x40.
    writePrefixedIntWithBase(writer, 0x40, nameBytes.length, 5);
    writer.writeBytes(nameBytes);
    writeStringLiteral(writer, value);
}

/**
 * Read one encoder instruction and apply it to the table (§4.3).
 *   - 001 <cap 5+>            Set Dynamic Table Capacity
 *   - 1 T <nameIdx 6+> <val>  Insert With Name Reference
 *   - 01 <name> <value>        Insert With Literal Name
 *   - 000 <idx 5+>             Duplicate
 */
function readEncoderInstruction(reader: ByteReader, table: QpackDynamicTable): void {
    const first = reader.peek();
    if ((first & 0xe0) === 0x40) {
        // 01... Insert With Literal Name (§4.3.3).
        const name = readTaggedStringLiteral(reader, 5);
        const value = readStringLiteral(reader);
        table.insert(name, value);
        return;
    }
    if ((first & 0x80) !== 0) {
        // 1 T <nameIdx 6+> Insert With Name Reference (§4.3.2).
        const prefixed = readPrefixedInt(reader, 6);
        const t = (prefixed >> 5) & 1;
        const nameIndex = prefixed & 0x1f;
        const value = readStringLiteral(reader);
        const name =
            t === 1 ? STATIC_TABLE[nameIndex]?.name : table.getByAbsoluteIndex(nameIndex)?.name;
        if (name === undefined) {
            throw new QpackDecodeError("insert name ref: invalid index");
        }
        table.insert(name, value);
        return;
    }
    if ((first & 0xe0) === 0x20) {
        // 001 <cap 5+> Set Dynamic Table Capacity (§4.3.1).
        const capacity = readPrefixedInt(reader, 5);
        table.setCapacity(capacity);
        return;
    }
    if ((first & 0xe0) === 0x00) {
        // 000 <idx 5+> Duplicate (§4.3.4).
        const relative = readPrefixedInt(reader, 5);
        const absolute = table.relativeToAbsolute(relative);
        const entry = table.getByAbsoluteIndex(absolute);
        if (entry === undefined) {
            throw new QpackDecodeError("duplicate: invalid relative index");
        }
        table.insert(entry.name, entry.value);
        return;
    }
    throw new QpackDecodeError(`unknown encoder instruction byte 0x${first.toString(16)}`);
}

// Re-exports.
export { STATIC_TABLE, QpackDynamicTable };
