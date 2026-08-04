/**
 * QPACK: Field Compression for HTTP/3 (RFC 9204).
 *
 * Two wire layers:
 *   1. Field-line representations -- encode/decode header blocks against the
 *      static table and a shared dynamic table (section 3, 4.5).
 *   2. Wire instructions -- synchronize the dynamic table over the two
 *      unidirectional QPACK streams (section 4.3, 4.4).
 *
 * This implementation always emits H=0 (no Huffman) string literals and
 * decodes H=0 literals. Huffman encoding is optional in QPACK and omitted
 * here for deterministic, testable output.
 */

import type { Bytes, HeaderField } from "../types.js";
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

function findStaticField(name: string, value: string): number {
    for (let i = 0; i < STATIC_TABLE.length; i += 1) {
        const entry = STATIC_TABLE[i]!;
        if (entry.name === name && entry.value === value) {
            return i;
        }
    }
    return -1;
}

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

/** Encode one field line against the static table only. */
function encodeStaticFieldLine(writer: ByteWriter, name: string, value: string): void {
    const fullIndex = findStaticField(name, value);
    if (fullIndex !== -1) {
        // Indexed Field Line, static: 1 T <index 6+> (T=1 -> bits 7-6 = 11 -> base 0xC0)
        writePrefixedIntWithBase(writer, 0xc0, fullIndex, 6);
        return;
    }
    const nameIndex = findStaticName(name);
    if (nameIndex !== -1) {
        // Literal with Name Reference, static: 0 1 N T <nameIndex 4+> (N=0,T=1 -> base 0x50)
        writePrefixedIntWithBase(writer, 0x50, nameIndex, 4);
        writeStringLiteral(writer, value);
        return;
    }
    // Literal with Literal Name: 0 0 1 N H <name> <value> (N=0,H=0 -> base 0x20).
    const nameBytes = new TextEncoder().encode(name);
    writePrefixedIntWithBase(writer, 0x20, nameBytes.length, 3);
    writer.writeBytes(nameBytes);
    writeStringLiteral(writer, value);
}

/** Encode a header map into a QPACK header block using only the static table. */
export function encodeHeaders(headers: ReadonlyMap<string, string>): Bytes {
    const writer = new ByteWriter();
    writer.write(0x00); // Required Insert Count = 0 (8-bit prefix)
    writer.write(0x00); // S=0, Delta Base = 0 (7-bit prefix)
    for (const [name, value] of headers) {
        encodeStaticFieldLine(writer, name, value);
    }
    return writer.toBytes();
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
    const nameLength = readPrefixedInt(reader, 3); // 0 0 1 N H <NameLen 3+>
    const name = new TextDecoder().decode(reader.readBytes(nameLength));
    const value = readStringLiteral(reader);
    return { name, value };
}

/** Decode a static-table-only header block into a header map. */
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

// ---------------------------------------------------------------------------
// Dynamic-table-aware encoder / decoder (Step 4)
// ---------------------------------------------------------------------------

/** QPACK encoder: produces header blocks and encoder-stream instructions. */
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

    /** Encode a header block. */
    public encode(headers: ReadonlyMap<string, string>): {
        block: Bytes;
        requiredInsertCount: number;
        encoderBytes: Bytes;
    } {
        const fieldsWriter = new ByteWriter();
        const encWriter = new ByteWriter();
        const base = this.table.insertCount;
        let requiredInsertCount = 0;

        for (const [name, value] of headers) {
            const existing = this.findDynamic(name, value);
            if (existing !== -1) {
                const relative = base - 1 - existing;
                writeDynamicIndexRef(fieldsWriter, relative);
                requiredInsertCount = Math.max(requiredInsertCount, existing + 1);
            } else {
                writeInsertLiteralName(encWriter, name, value);
                this.table.insert(name, value);
                const postBase = this.table.insertCount - base - 1;
                writePostBaseIndexRef(fieldsWriter, postBase);
                requiredInsertCount = this.table.insertCount;
            }
        }

        const blockWriter = new ByteWriter();
        writeBlockPrefix(blockWriter, requiredInsertCount, base);
        blockWriter.writeBytes(fieldsWriter.toBytes());
        return {
            block: blockWriter.toBytes(),
            requiredInsertCount,
            encoderBytes: encWriter.toBytes(),
        };
    }

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

/** QPACK decoder: decodes header blocks and emits decoder-stream instructions. */
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

    /** Decode a header block given its Required Insert Count. */
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
            const field = this.readBlockRepresentation(reader, base);
            out.set(field.name, field.value);
        }
        return out;
    }

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
        const ric = this.table.insertCount;
        return sign ? ric - deltaBase - 1 : ric + deltaBase;
    }

    private readBlockRepresentation(reader: ByteReader, base: number): HeaderField {
        const first = reader.peek();
        if ((first & 0x80) !== 0) {
            return this.decodeIndexed(reader, base);
        }
        if ((first & 0xc0) === 0x40) {
            return this.decodeLiteralNameRef(reader, base);
        }
        if ((first & 0xf0) === 0x10) {
            return this.decodePostBaseIndexed(reader, base);
        }
        if ((first & 0xf0) === 0x00) {
            return this.decodePostBaseLiteralNameRef(reader, base);
        }
        return decodeLiteralLiteral(reader);
    }

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
        const absolute = base - 1 - index;
        const entry = this.table.getByAbsoluteIndex(absolute);
        if (entry === undefined) {
            throw new QpackDecodeError(`indexed field line: invalid dynamic index ${index}`);
        }
        return { name: entry.name, value: entry.value };
    }

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

    private decodePostBaseIndexed(reader: ByteReader, base: number): HeaderField {
        const postBase = readPrefixedInt(reader, 4);
        const absolute = base + postBase;
        const entry = this.table.getByAbsoluteIndex(absolute);
        if (entry === undefined) {
            throw new QpackDecodeError(`post-base indexed: invalid index ${postBase}`);
        }
        return { name: entry.name, value: entry.value };
    }

    private decodePostBaseLiteralNameRef(reader: ByteReader, base: number): HeaderField {
        const postBase = readPrefixedInt(reader, 3);
        const value = readStringLiteral(reader);
        const absolute = base + postBase;
        const entry = this.table.getByAbsoluteIndex(absolute);
        if (entry === undefined) {
            throw new QpackDecodeError(`post-base name ref: invalid index ${postBase}`);
        }
        return { name: entry.name, value };
    }

    /** Consume encoder-stream bytes: apply Set capacity / Insert / Duplicate. */
    public consumeEncoderStream(buf: Bytes): void {
        const reader = new ByteReader(buf);
        while (reader.remaining > 0) {
            readEncoderInstruction(reader, this.table);
        }
        this.pendingInserts += this.table.insertCount;
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

function writeBlockPrefix(writer: ByteWriter, requiredInsertCount: number, base: number): void {
    writePrefixedInt(writer, requiredInsertCount, 8);
    const sign = base >= requiredInsertCount ? 0 : 0x80;
    const deltaBase =
        base >= requiredInsertCount ? base - requiredInsertCount : requiredInsertCount - base - 1;
    writePrefixedIntWithBase(writer, sign, deltaBase, 7);
}

function writeDynamicIndexRef(writer: ByteWriter, relative: number): void {
    writePrefixedIntWithBase(writer, 0x80, relative, 6);
}

function writePostBaseIndexRef(writer: ByteWriter, postBase: number): void {
    writePrefixedIntWithBase(writer, 0x10, postBase, 4);
}

// ---------------------------------------------------------------------------
// Wire instructions (encoder + decoder streams)
// ---------------------------------------------------------------------------

/** Write an Insert-With-Literal-Name encoder instruction: 01 <name> <value>. */
function writeInsertLiteralName(writer: ByteWriter, name: string, value: string): void {
    const nameBytes = new TextEncoder().encode(name);
    // section 4.3.3: 01 H <Name Length 5+>; H=0 -> base 0b010_00000 = 0x40.
    writePrefixedIntWithBase(writer, 0x40, nameBytes.length, 5);
    writer.writeBytes(nameBytes);
    writeStringLiteral(writer, value);
}

/**
 * Read one encoder instruction and apply it to the table (section 4.3).
 *   - 001 <cap 5+>            Set Dynamic Table Capacity
 *   - 1 T <nameIdx 6+> <val>  Insert With Name Reference
 *   - 01 <name> <value>        Insert With Literal Name
 *   - 000 <idx 5+>             Duplicate
 */
function readEncoderInstruction(reader: ByteReader, table: QpackDynamicTable): void {
    const first = reader.peek();
    if ((first & 0xe0) === 0x40) {
        // 01... Insert With Literal Name (section 4.3.3).
        const name = readTaggedStringLiteral(reader, 5);
        const value = readStringLiteral(reader);
        table.insert(name, value);
        return;
    }
    if ((first & 0x80) !== 0) {
        // 1 T <nameIdx 6+> Insert With Name Reference (section 4.3.2).
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
        // 001 <cap 5+> Set Dynamic Table Capacity (section 4.3.1).
        const capacity = readPrefixedInt(reader, 5);
        table.setCapacity(capacity);
        return;
    }
    if ((first & 0xe0) === 0x00) {
        // 000 <idx 5+> Duplicate (section 4.3.4).
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

export { STATIC_TABLE, QpackDynamicTable };
