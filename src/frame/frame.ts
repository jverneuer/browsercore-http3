/**
 * HTTP/3 frame parser and serializer (RFC 9114 §7).
 *
 * Pure wire-format logic — no I/O. Each frame is `Type (varint) | Length
 * (varint) | Payload`. Frames are written onto typed QUIC streams; the frame
 * layer does not own the stream.
 *
 * Wire format per frame variant:
 *   0x0  DATA         raw bytes
 *   0x1  HEADERS      QPACK-encoded header block (raw bytes)
 *   0x3  CANCEL_PUSH  push_id varint
 *   0x4  SETTINGS     repeated (id varint, value varint)
 *   0x5  PUSH_PROMISE push_id varint + QPACK block (raw bytes)
 *   0x7  GOAWAY       stream_id varint
 *   0x0d MAX_PUSH_ID  push_id varint
 *
 * Unknown frame types in the reserved/GREASE ranges (0x2, 0xb..0x1f, 0x21+)
 * MUST be ignored per RFC 9114 §7.1 — `readFrame` returns them as an
 * `Http3UnknownFrame` carrying the raw type + payload so callers can skip them.
 */

import {
    Http3FrameType,
    HTTP3_UNKNOWN_FRAME_TYPE,
    type BaseHttp3Frame,
    type Bytes,
    type Http3Frame,
    type Http3FrameTypeValue,
    type Http3SettingsKey,
    type Http3SettingsMap,
    type Http3UnknownFrame,
} from "../types.js";
import { concat, concatAll } from "../utils.js";
import { decodeVarint, encodeVarint } from "./varint.js";
import { FrameParseError } from "../errors.js";

export {
    Http3FrameType,
    HTTP3_UNKNOWN_FRAME_TYPE,
    type BaseHttp3Frame,
    type Http3Frame,
    type Http3FrameTypeValue,
    type Http3UnknownFrame,
};

/**
 * Narrow `Http3Frame` to the variant carrying the given `type`.
 * Useful when a handler only cares about one frame variant.
 */
export type Http3FrameOfType<T extends Http3FrameTypeValue> = Extract<
    Http3Frame,
    { readonly type: T }
>;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Compute the wire `type` code for a frame (handles unknown frames). */
function frameTypeCode(frame: Http3Frame): bigint {
    if (frame.type === HTTP3_UNKNOWN_FRAME_TYPE) {
        return BigInt(frame.rawType);
    }
    return BigInt(frame.type);
}

/** Serialize a frame's payload (everything after the type + length). */
function serializePayload(frame: Http3Frame): Bytes {
    switch (frame.type) {
        case Http3FrameType.DATA:
        case Http3FrameType.HEADERS:
            return frame.payload;
        case Http3FrameType.CANCEL_PUSH:
            return encodeVarint(frame.pushId);
        case Http3FrameType.SETTINGS: {
            const parts: Bytes[] = [];
            for (const [key, value] of Object.entries(frame.settings)) {
                // `Object.entries` yields `number | undefined` values on a
                // Partial record; skip any undefined entries defensively.
                if (typeof value !== "number") {
                    continue;
                }
                parts.push(encodeVarint(BigInt(Number(key))), encodeVarint(BigInt(value)));
            }
            return concatAll(parts);
        }
        case Http3FrameType.PUSH_PROMISE:
            return concat(encodeVarint(frame.pushId), frame.payload);
        case Http3FrameType.GOAWAY:
            return encodeVarint(frame.streamId);
        case Http3FrameType.MAX_PUSH_ID:
            return encodeVarint(frame.pushId);
        case HTTP3_UNKNOWN_FRAME_TYPE:
            return frame.payload;
        default: {
            // Exhaustiveness guard — forces a compile error if a variant is
            // added without a serialization branch.
            const unreachable: never = frame;
            throw new Error(`serializePayload: unhandled frame type ${unreachable}`);
        }
    }
}

/** Serialize an HTTP/3 frame to wire bytes (type varint + length varint + payload). */
export function serializeFrame(frame: Http3Frame): Bytes {
    const payload = serializePayload(frame);
    return concatAll([
        encodeVarint(frameTypeCode(frame)),
        encodeVarint(BigInt(payload.length)),
        payload,
    ]);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The SETTINGS identifiers HTTP/3 defines (RFC 9114 §7.2.4). */
const Http3SettingsId = {
    QPACK_MAX_TABLE_CAPACITY: 0x1,
    MAX_FIELD_SECTION_SIZE: 0x6,
    QPACK_BLOCKED_STREAMS: 0x7,
} as const;

/** The SETTINGS ids we understand — unknown ids are ignored per RFC 9114 §7.2.4. */
const KNOWN_SETTINGS_IDS: ReadonlySet<bigint> = new Set([
    BigInt(Http3SettingsId.QPACK_MAX_TABLE_CAPACITY),
    BigInt(Http3SettingsId.MAX_FIELD_SECTION_SIZE),
    BigInt(Http3SettingsId.QPACK_BLOCKED_STREAMS),
]);

/** Parse a SETTINGS payload (repeated id/value varints) into a settings map. */
function parseSettings(payload: Bytes): Http3SettingsMap {
    const settings: Http3SettingsMap = {};
    let offset = 0;
    while (offset < payload.length) {
        const id = decodeVarint(payload.subarray(offset));
        const value = decodeVarint(payload.subarray(offset + id.length));
        offset += id.length + value.length;
        // Only retain known settings identifiers; unknown ones are ignored per
        // RFC 9114 §7.2.4. The set membership check narrows `id.value` to a
        // valid Http3SettingsKey so it can index the map.
        if (KNOWN_SETTINGS_IDS.has(id.value)) {
            const key = id.value as unknown as Http3SettingsKey;
            settings[key] = Number(value.value);
        }
    }
    return settings;
}

/** Parse a complete payload into the matching `Http3Frame` variant. */
function parseFramePayload(rawType: number, payload: Bytes): Http3Frame {
    switch (rawType) {
        case Http3FrameType.DATA:
            return { type: Http3FrameType.DATA, payload };
        case Http3FrameType.HEADERS:
            return { type: Http3FrameType.HEADERS, payload };
        case Http3FrameType.CANCEL_PUSH:
            return { type: Http3FrameType.CANCEL_PUSH, pushId: decodeVarint(payload).value };
        case Http3FrameType.SETTINGS:
            return { type: Http3FrameType.SETTINGS, settings: parseSettings(payload) };
        case Http3FrameType.PUSH_PROMISE: {
            const id = decodeVarint(payload);
            return {
                type: Http3FrameType.PUSH_PROMISE,
                pushId: id.value,
                payload: payload.subarray(id.length),
            };
        }
        case Http3FrameType.GOAWAY:
            return { type: Http3FrameType.GOAWAY, streamId: decodeVarint(payload).value };
        case Http3FrameType.MAX_PUSH_ID:
            return { type: Http3FrameType.MAX_PUSH_ID, pushId: decodeVarint(payload).value };
        default:
            // GREASE / reserved type — retain raw type + payload, ignore it.
            return { type: HTTP3_UNKNOWN_FRAME_TYPE, rawType, payload };
    }
}

// ---------------------------------------------------------------------------
// Stream reader
// ---------------------------------------------------------------------------

/**
 * Stateful reader that reassembles frames from a chunked byte source.
 *
 * QUIC delivers bytes in arbitrary chunks; a frame may be split across many
 * reads, and a single read may contain more than one frame. `FrameReader`
 * buffers surplus bytes between `readFrame()` calls so nothing is lost — this
 * is what makes it safe to read a stream of frames in a loop.
 */
export class FrameReader {
    private buffer: Bytes = new Uint8Array(0);

    public constructor(private readonly read: () => Promise<Bytes>) {}

    /** Top up the internal buffer until it holds at least `n` bytes. */
    private async ensure(n: number): Promise<void> {
        while (this.buffer.length < n) {
            // oxlint-disable-next-line no-await-in-loop -- each read depends on accumulated bytes; ordering is inherent
            const chunk = await this.read();
            if (chunk.length === 0) {
                throw new FrameParseError(this.buffer.length, {
                    cause: new Error("stream ended mid-frame"),
                });
            }
            this.buffer = concat(this.buffer, chunk);
        }
    }

    /** Consume exactly `n` bytes from the front of the buffer. */
    private async readBytes(n: number): Promise<Bytes> {
        if (n > Number.MAX_SAFE_INTEGER) {
            throw new FrameParseError(this.buffer.length, {
                cause: new Error("frame length exceeds safe integer"),
            });
        }
        await this.ensure(n);
        const out = this.buffer.subarray(0, n) as Bytes;
        this.buffer = this.buffer.subarray(n);
        return out;
    }

    /** Read one varint (1–8 bytes) from the buffer. */
    private async readVarint(): Promise<{ value: bigint; length: number }> {
        const first = await this.readBytes(1);
        // readBytes(1) guarantees a single octet; extract it without a non-null
        // assertion (noUncheckedIndexedAccess makes array access nullable).
        const firstOctet = first[0] ?? 0;
        const prefix = firstOctet >> 6;
        const total = 1 << prefix; // 1, 2, 4, or 8
        if (total === 1) {
            return decodeVarint(first);
        }
        const rest = await this.readBytes(total - 1);
        return decodeVarint(concat(first, rest));
    }

    /** Read and parse one frame. Throws FrameParseError on malformed input. */
    public async readFrame(): Promise<Http3Frame> {
        const type = await this.readVarint();
        const length = await this.readVarint();
        if (length.value > Number.MAX_SAFE_INTEGER) {
            throw new FrameParseError(this.buffer.length, {
                cause: new Error("frame length exceeds safe integer"),
            });
        }
        const payload = await this.readBytes(Number(length.value));
        return parseFramePayload(Number(type.value), payload);
    }
}

/**
 * Read one frame from a chunk source. Convenience wrapper around a throwaway
 * {@link FrameReader}; suitable for reading a single frame or for tests. To
 * read a stream of multiple frames without losing bytes between calls, use a
 * persistent {@link FrameReader} instance.
 */
export function readFrame(read: () => Promise<Bytes>): Promise<Http3Frame> {
    return new FrameReader(read).readFrame();
}
