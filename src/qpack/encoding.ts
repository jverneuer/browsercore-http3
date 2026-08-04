/**
 * QPACK low-level wire primitives: prefixed integers and string literals.
 *
 * Prefixed integers (RFC 7541 §5.1): an N-bit prefix where values below
 * 2^N − 1 fit in the prefix, and larger values spill into 7-bit continuation
 * bytes. String literals (RFC 7541 §5.2) carry an H flag (Huffman): H=1 means
 * the bytes are Huffman-coded with the static RFC 7541 Appendix B table (reused
 * by QPACK, RFC 9204 §2.1.3), H=0 means raw octets.
 *
 * The encoder emits H=1 (Huffman) by default — that is what real servers
 * produce, and it is almost always smaller. The decoder accepts both forms.
 */

import { QpackDecodeError } from "../errors.js";
import { HUFFMAN_TABLE } from "./huffman-table.js";

/** Byte-oriented writer that accumulates wire bytes. */
export class ByteWriter {
    private readonly bytes: number[] = [];

    public write(byte: number): void {
        this.bytes.push(byte & 0xff);
    }

    public writeBytes(data: Uint8Array): void {
        for (const b of data) {this.bytes.push(b);}
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
        // pos is guarded above; read the octet without a non-null assertion.
        const octet = this.buf[this.pos];
        return octet ?? 0;
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


// ---------------------------------------------------------------------------
// Huffman coding (RFC 7541 Appendix B, reused by QPACK RFC 9204 §2.1.3)
// ---------------------------------------------------------------------------

/** Encode raw octets into a Huffman bitstring (MSB-first), padded with 1-bits. */
export function huffmanEncode(input: Uint8Array): Uint8Array {
    let buffer = 0;
    let bitsInBuffer = 0;
    const out: number[] = [];
    for (const byte of input) {
        const row = HUFFMAN_TABLE[byte];
        if (row === undefined) {
            throw new QpackDecodeError(`huffman encode: invalid byte value ${byte}`);
        }
        buffer = (buffer << row.bits) | row.code;
        bitsInBuffer += row.bits;
        while (bitsInBuffer >= 8) {
            bitsInBuffer -= 8;
            out.push((buffer >>> bitsInBuffer) & 0xff);
        }
    }
    if (bitsInBuffer > 0) {
        const padBits = 8 - bitsInBuffer;
        const padding = (1 << padBits) - 1;
        out.push(((buffer << padBits) | padding) & 0xff);
    }
    return Uint8Array.from(out);
}

/** Decode a Huffman-coded string of `length` octets from the reader. */
export function huffmanDecode(reader: ByteReader, length: number): string {
    let bitBuffer = 0;
    let bitsAvailable = 0;
    let remaining = length;
    const chars: number[] = [];
    while (remaining > 0 || bitsAvailable > 0) {
        while (bitsAvailable < 30 && remaining > 0) {
            bitBuffer = bitBuffer * 256 + reader.read();
            bitsAvailable += 8;
            remaining -= 1;
        }
        let matched = false;
        for (const row of HUFFMAN_TABLE) {
            if (row.bits > bitsAvailable) continue;
            const shift = bitsAvailable - row.bits;
            const top = Math.floor(bitBuffer / 2 ** shift) % (2 ** row.bits);
            if (top === row.code) {
                chars.push(row.symbol);
                bitsAvailable = shift;
                bitBuffer = bitsAvailable > 0 ? bitBuffer % (2 ** bitsAvailable) : 0;
                matched = true;
                break;
            }
        }
        if (!matched) throw new QpackDecodeError("huffman decode: no matching code");
        if (remaining === 0) {
            const mod = bitsAvailable > 0 ? 2 ** bitsAvailable : 1;
            if (bitBuffer % mod === mod - 1) break;
        }
    }
    return new TextDecoder().decode(Uint8Array.from(chars));
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

/** Write a string literal with Huffman coding (H=1). */
export function writeStringLiteral(writer: ByteWriter, str: string): void {
    const raw = new TextEncoder().encode(str);
    const encoded = huffmanEncode(raw);
    // H=1 in the high bit (base 0x80); the 7-bit prefix holds the length.
    writePrefixedIntWithBase(writer, 0x80, encoded.length, 7);
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
    // RFC 9204 §4.3.3 (Insert-With-Literal-Name): 01 H <Name Length n+>. The
    // H flag sits just above the n-bit length prefix, i.e. at bit n; the
    // length occupies bits n-1..0. (Using bit n-1 here would misread the H
    // flag and reject names whose length sets that bit.)
    const huffmanMask = 1 << n;
    const lengthMask = (1 << n) - 1;
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
        return huffmanDecode(reader, length);
    }
    const bytes = reader.readBytes(length);
    return new TextDecoder().decode(bytes);
}

/**
 * Read a string literal. The high bit of the 7-bit length prefix is the
 * Huffman flag: H=0 raw octets, H=1 Huffman-coded. Returns the decoded string.
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
        return huffmanDecode(reader, length);
    }
    const bytes = reader.readBytes(length);
    return new TextDecoder().decode(bytes);
}
