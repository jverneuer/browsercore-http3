/**
 * QPACK low-level wire primitives: prefixed integers and string literals.
 *
 * Prefixed integers (RFC 7541 §5.1): an N-bit prefix where values below
 * 2^N − 1 fit in the prefix, and larger values spill into 7-bit continuation
 * bytes. String literals (RFC 7541 §5.2) carry an H flag (Huffman); this
 * implementation always encodes with H=0 (raw bytes — Huffman is optional per
 * RFC 9204) and decodes H=0 literals.
 */

import { QpackDecodeError } from "../errors.js";

/** Byte-oriented writer that accumulates wire bytes. */
export class ByteWriter {
    private readonly bytes: number[] = [];

    public write(byte: number): void {
        this.bytes.push(byte & 0xff);
    }

    public writeBytes(data: Uint8Array): void {
        for (const b of data) this.bytes.push(b);
    }

    public toBytes(): Uint8Array {
        return Uint8Array.from(this.bytes);
    }
}

/** Byte-oriented reader with a position cursor. */
export class ByteReader {
    private pos = 0;

    public constructor(private readonly buf: Uint8Array) {}

    public get offset(): number {
        return this.pos;
    }

    public get remaining(): number {
        return this.buf.length - this.pos;
    }

    public peek(): number {
        if (this.pos >= this.buf.length) {
            throw new QpackDecodeError(`byte read past end at offset ${this.pos}`);
        }
        return this.buf[this.pos]!;
    }

    public read(): number {
        const b = this.peek();
        this.pos += 1;
        return b;
    }

    public readBytes(n: number): Uint8Array {
        if (n > this.remaining) {
            throw new QpackDecodeError(`byte read past end at offset ${this.pos}`);
        }
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }
}

/**
 * Write a prefixed integer with an N-bit prefix (2 ≤ N ≤ 8).
 * `prefixBits` is the number of low bits of the first byte used for the value.
 */
export function writePrefixedInt(writer: ByteWriter, value: number, prefixBits: number): void {
    const max = (1 << prefixBits) - 1;
    if (value < max) {
        writer.write(value);
        return;
    }
    writer.write(max);
    let remaining = value - max;
    while (remaining >= 128) {
        writer.write((remaining % 128) + 128);
        remaining = Math.floor(remaining / 128);
    }
    writer.write(remaining);
}

/** Read a prefixed integer with an N-bit prefix. Returns the decoded value. */
export function readPrefixedInt(reader: ByteReader, prefixBits: number): number {
    const max = (1 << prefixBits) - 1;
    const first = reader.read();
    let value = first & max;
    if (value < max) {
        return value;
    }
    let m = 0;
    let byte = 0;
    do {
        byte = reader.read();
        value += (byte & 0x7f) * (1 << m);
        m += 7;
        if (m > 62) {
            throw new QpackDecodeError("prefixed integer overflow");
        }
    } while ((byte & 0x80) !== 0);
    return value;
}

/** Write a string literal with H=0 (raw bytes, no Huffman). */
export function writeStringLiteral(writer: ByteWriter, str: string): void {
    const encoded = new TextEncoder().encode(str);
    // H=0 in the high bit; the 7-bit prefix holds the length.
    writePrefixedInt(writer, encoded.length, 7);
    writer.writeBytes(encoded);
}

/**
 * Write a prefixed integer where only the low `n` bits of the first byte hold
 * the value, OR'd onto a 3-bit tag already placed in the high bits.
 *
 * Used for QPACK string literals whose high bits carry an instruction tag and
 * an H flag (e.g. Insert-With-Literal-Name's name length uses a 5-bit prefix
 * with the top 3 bits = `010`). `base` supplies those top bits; `n` is the
 * number of low bits available for the value.
 */
export function writePrefixedIntWithBase(
    writer: ByteWriter,
    base: number,
    value: number,
    n: number,
): void {
    const max = (1 << n) - 1;
    if (value < max) {
        writer.write(base | value);
        return;
    }
    writer.write(base | max);
    let remaining = value - max;
    while (remaining >= 128) {
        writer.write((remaining % 128) + 128);
        remaining = Math.floor(remaining / 128);
    }
    writer.write(remaining);
}

/**
 * Read a string literal whose length prefix shares its first byte with an
 * instruction tag. `n` is the number of low bits of the first byte used for
 * the length; the high bit of those `n` bits is the Huffman flag. Returns the
 * decoded string. Throws on H=1 (Huffman unsupported).
 */
export function readTaggedStringLiteral(reader: ByteReader, n: number): string {
    const first = reader.read();
    const huffmanMask = 1 << (n - 1);
    const lengthMask = huffmanMask - 1;
    const huffman = (first & huffmanMask) !== 0;
    let length = first & lengthMask;
    const max = (1 << n) - 1;
    if (length === max) {
        let m = 0;
        let byte = 0;
        do {
            byte = reader.read();
            length += (byte & 0x7f) * (1 << m);
            m += 7;
        } while ((byte & 0x80) !== 0);
    }
    if (huffman) {
        throw new QpackDecodeError("Huffman-encoded string literal unsupported");
    }
    const bytes = reader.readBytes(length);
    return new TextDecoder().decode(bytes);
}

/**
 * Read a string literal. Supports H=0 (raw). Throws QpackDecodeError on H=1
 * (Huffman), which this implementation does not encode and does not support
 * decoding (Huffman is optional per RFC 9204).
 */
export function readStringLiteral(reader: ByteReader): string {
    const first = reader.read();
    const huffman = (first & 0x80) !== 0;
    let length = first & 0x7f;
    const max = (1 << 7) - 1;
    if (length === max) {
        // Multi-byte length — rare for short field values; decode it.
        let m = 0;
        let byte = 0;
        do {
            byte = reader.read();
            length += (byte & 0x7f) * (1 << m);
            m += 7;
        } while ((byte & 0x80) !== 0);
    }
    if (huffman) {
        throw new QpackDecodeError("Huffman-encoded string literal unsupported");
    }
    const bytes = reader.readBytes(length);
    return new TextDecoder().decode(bytes);
}
