/**
 * Exhaustive HTTP/3 frame layer coverage.
 *
 * Extends the round-trip focus of frame.test.ts with byte-exact serialization
 * assertions, every varint bucket edge ±1, multi-byte type/length varints,
 * GREASE coverage across ALL reserved ranges, SETTINGS id filtering including
 * duplicates and zeros, FrameReader chunk-split at every boundary, max-value
 * stream/push ids, and FrameParseError offset semantics.
 */

import { describe, it, expect } from "vitest";
import {
    FrameReader,
    HTTP3_UNKNOWN_FRAME_TYPE,
    Http3FrameType,
    Http3Settings,
    VARINT_MAX,
    type Bytes,
    type Http3Frame,
    type Http3UnknownFrame,
} from "../src/index.js";
import { readFrame, serializeFrame } from "../src/frame/frame.js";
import { decodeVarint, encodeVarint, getVarintEncodedLength } from "../src/frame/varint.js";
import { concat } from "../src/utils.js";
import { FrameParseError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed `bytes` to a fresh FrameReader, collecting every frame until EOF. */
async function parseAll(bytes: Bytes): Promise<Http3Frame[]> {
    let emitted = false;
    const reader = new FrameReader(async () => {
        if (emitted) return new Uint8Array(0);
        emitted = true;
        return bytes;
    });
    const out: Http3Frame[] = [];
    for (;;) {
        try {
            out.push(await reader.readFrame());
        } catch {
            break;
        }
    }
    return out;
}

/** Assert a single frame round-trips and returns the parsed frame. */
async function roundTripOne(frame: Http3Frame): Promise<Http3Frame> {
    const parsed = await parseAll(serializeFrame(frame));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe(frame.type);
    return parsed[0]!;
}

// ===========================================================================
// VARINT — exhaustive bucket edges ±1
// ===========================================================================

describe("varint — bucket edges ±1", () => {
    const ONE_BYTE_MAX = (1n << 6n) - 1n; // 63
    const TWO_BYTE_MIN = 1n << 6n; // 64
    const TWO_BYTE_MAX = (1n << 14n) - 1n; // 16383
    const FOUR_BYTE_MIN = 1n << 14n; // 16384
    const FOUR_BYTE_MAX = (1n << 30n) - 1n; // 1073741823
    const EIGHT_BYTE_MIN = 1n << 30n; // 1073741824

    it("1-byte bucket: 0, 1, max-1, max", () => {
        for (const v of [0n, 1n, ONE_BYTE_MAX - 1n, ONE_BYTE_MAX]) {
            expect(getVarintEncodedLength(v)).toBe(1);
            expect(decodeVarint(encodeVarint(v)).value).toBe(v);
        }
    });

    it("2-byte bucket: min, min+1, max-1, max", () => {
        for (const v of [TWO_BYTE_MIN, TWO_BYTE_MIN + 1n, TWO_BYTE_MAX - 1n, TWO_BYTE_MAX]) {
            expect(getVarintEncodedLength(v)).toBe(2);
            expect(decodeVarint(encodeVarint(v)).value).toBe(v);
        }
    });

    it("4-byte bucket: min, min+1, max-1, max", () => {
        for (const v of [FOUR_BYTE_MIN, FOUR_BYTE_MIN + 1n, FOUR_BYTE_MAX - 1n, FOUR_BYTE_MAX]) {
            expect(getVarintEncodedLength(v)).toBe(4);
            expect(decodeVarint(encodeVarint(v)).value).toBe(v);
        }
    });

    it("8-byte bucket: min, min+1, VARINT_MAX-1, VARINT_MAX", () => {
        for (const v of [EIGHT_BYTE_MIN, EIGHT_BYTE_MIN + 1n, VARINT_MAX - 1n, VARINT_MAX]) {
            expect(getVarintEncodedLength(v)).toBe(8);
            expect(decodeVarint(encodeVarint(v)).value).toBe(v);
        }
    });

    it("prefix bits are exactly correct for each form", () => {
        // 00, 01, 10, 11 for 1/2/4/8 bytes respectively.
        const cases: Array<[bigint, number]> = [
            [0n, 0],
            [TWO_BYTE_MIN, 1],
            [FOUR_BYTE_MIN, 2],
            [EIGHT_BYTE_MIN, 3],
        ];
        for (const [value, expectedPrefix] of cases) {
            const bytes = encodeVarint(value);
            expect(bytes[0]! >> 6).toBe(expectedPrefix);
            // Payload bits in the first byte must not leak into the prefix.
            expect(bytes[0]! & 0x3f).toBe(Number(value >> BigInt((bytes.length - 1) * 8)));
        }
    });

    it("1-byte form never sets the top two bits even at max", () => {
        const bytes = encodeVarint(ONE_BYTE_MAX);
        expect(bytes).toHaveLength(1);
        expect(bytes[0]).toBe(0x3f); // 6 payload bits all set.
        expect(bytes[0]! >> 6).toBe(0);
    });
});

describe("varint — decode consumes only `length` bytes (trailing garbage)", () => {
    it("ignores trailing bytes after a 1-byte varint", () => {
        const { value, length } = decodeVarint(new Uint8Array([0x3f, 0xde, 0xad, 0xbe, 0xef]));
        expect(value).toBe(63n);
        expect(length).toBe(1);
    });

    it("ignores trailing bytes after a 2-byte varint", () => {
        // 0x40 0x40 = 64.
        const { value, length } = decodeVarint(new Uint8Array([0x40, 0x40, 0xff]));
        expect(value).toBe(64n);
        expect(length).toBe(2);
    });

    it("ignores trailing bytes after a 4-byte varint", () => {
        // 16384 = 0x4000 → 4-byte varint: 0x80 0x00 0x40 0x00.
        const { value, length } = decodeVarint(new Uint8Array([0x80, 0x00, 0x40, 0x00, 0x99, 0x99]));
        expect(value).toBe(16384n);
        expect(length).toBe(4);
    });

    it("ignores trailing bytes after an 8-byte varint", () => {
        // 1073741824 = 0x40000000 → 8-byte varint: 0xc0 0x00 0x00 0x00 0x40 0x00 0x00 0x00.
        const { value, length } = decodeVarint(
            new Uint8Array([0xc0, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x42]),
        );
        expect(value).toBe(1073741824n);
        expect(length).toBe(8);
    });
});

describe("varint — decode rejects truncated buffers for every form", () => {
    it("2-byte form truncated to 1 byte", () => {
        expect(() => decodeVarint(new Uint8Array([0x40]))).toThrow(RangeError);
    });

    it("4-byte form truncated to 1, 2, or 3 bytes", () => {
        expect(() => decodeVarint(new Uint8Array([0x80]))).toThrow(RangeError);
        expect(() => decodeVarint(new Uint8Array([0x80, 0x00]))).toThrow(RangeError);
        expect(() => decodeVarint(new Uint8Array([0x80, 0x00, 0x00]))).toThrow(RangeError);
    });

    it("8-byte form truncated to 1..7 bytes", () => {
        for (let i = 1; i <= 7; i++) {
            const buf = new Uint8Array(i).fill(0xc0);
            buf[0] = 0xc0;
            expect(() => decodeVarint(buf)).toThrow(RangeError);
        }
    });

    it("empty buffer throws", () => {
        expect(() => decodeVarint(new Uint8Array(0))).toThrow(RangeError);
        expect(() => decodeVarint(new Uint8Array(0))).toThrow(/empty/);
    });
});

describe("varint — round-trip structured interior sample", () => {
    it("round-trips a deterministic spread of interior values", () => {
        const samples: bigint[] = [
            2n ** 7n,
            2n ** 10n,
            2n ** 20n,
            2n ** 31n,
            2n ** 45n,
            2n ** 50n,
            2n ** 60n,
            2n ** 61n,
            (2n ** 61n) + 1234567n,
            VARINT_MAX ^ (1n << 37n), // clear one interior bit
        ];
        for (const v of samples) {
            const encoded = encodeVarint(v);
            const decoded = decodeVarint(encoded);
            expect(decoded.value).toBe(v);
            expect(decoded.length).toBe(encoded.length);
        }
    });
});

// ===========================================================================
// FRAME SERIALIZATION — byte-exact for every variant
// ===========================================================================

describe("serializeFrame — byte-exact wire bytes", () => {
    it("DATA: type 0x0 + length varint + payload", () => {
        const bytes = serializeFrame({
            type: Http3FrameType.DATA,
            payload: new Uint8Array([0xca, 0xfe]),
        });
        // type=0x00, length=0x02, payload.
        expect(bytes).toEqual(new Uint8Array([0x00, 0x02, 0xca, 0xfe]));
    });

    it("DATA: empty payload yields length 0", () => {
        const bytes = serializeFrame({
            type: Http3FrameType.DATA,
            payload: new Uint8Array(0),
        });
        expect(bytes).toEqual(new Uint8Array([0x00, 0x00]));
    });

    it("HEADERS: type 0x1 + length varint + payload", () => {
        const bytes = serializeFrame({
            type: Http3FrameType.HEADERS,
            payload: new Uint8Array([0x03, 0x04]),
        });
        expect(bytes).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    });

    it("CANCEL_PUSH: type 0x3 + length + pushId varint", () => {
        const bytes = serializeFrame({ type: Http3FrameType.CANCEL_PUSH, pushId: 8n });
        // type=0x03, length=0x01, pushId=0x08.
        expect(bytes).toEqual(new Uint8Array([0x03, 0x01, 0x08]));
    });

    it("CANCEL_PUSH: pushId 0 encodes as a single zero byte", () => {
        const bytes = serializeFrame({ type: Http3FrameType.CANCEL_PUSH, pushId: 0n });
        expect(bytes).toEqual(new Uint8Array([0x03, 0x01, 0x00]));
    });

    it("SETTINGS: empty settings yields type + length 0", () => {
        const bytes = serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(bytes).toEqual(new Uint8Array([0x04, 0x00]));
    });

    it("SETTINGS: id 0x1 = 4096, id 0x7 = 16, encoded in order", () => {
        const bytes = serializeFrame({
            type: Http3FrameType.SETTINGS,
            settings: {
                [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096,
                [Http3Settings.QPACK_BLOCKED_STREAMS]: 16,
            },
        });
        // 4096 = 0x1000 → 2-byte varint: 0x50 0x00.
        // type=0x04, length=0x05 (2+1+2 bytes of id/value pairs), id=0x01,
        // value=0x50 0x00, id=0x07, value=0x10.
        expect(bytes).toEqual(
            new Uint8Array([0x04, 0x05, 0x01, 0x50, 0x00, 0x07, 0x10]),
        );
    });

    it("SETTINGS: zero-value settings encode the value as 0", () => {
        const bytes = serializeFrame({
            type: Http3FrameType.SETTINGS,
            settings: {
                [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 0,
            },
        });
        // type=0x04, length=0x02, id=0x01, value=0x00.
        expect(bytes).toEqual(new Uint8Array([0x04, 0x02, 0x01, 0x00]));
    });

    it("PUSH_PROMISE: type 0x5 + length + pushId + QPACK block", () => {
        const bytes = serializeFrame({
            type: Http3FrameType.PUSH_PROMISE,
            pushId: 2n,
            payload: new Uint8Array([0x10]),
        });
        // type=0x05, length=0x02 (pushId=1 byte + payload=1 byte), pushId=0x02, payload=0x10.
        expect(bytes).toEqual(new Uint8Array([0x05, 0x02, 0x02, 0x10]));
    });

    it("PUSH_PROMISE: empty QPACK block", () => {
        const bytes = serializeFrame({
            type: Http3FrameType.PUSH_PROMISE,
            pushId: 0n,
            payload: new Uint8Array(0),
        });
        // type=0x05, length=0x01, pushId=0x00.
        expect(bytes).toEqual(new Uint8Array([0x05, 0x01, 0x00]));
    });

    it("GOAWAY: type 0x7 + length + streamId varint", () => {
        const bytes = serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 0n });
        // type=0x07, length=0x01, streamId=0x00.
        expect(bytes).toEqual(new Uint8Array([0x07, 0x01, 0x00]));
    });

    it("GOAWAY: large streamId uses a 2-byte varint", () => {
        const bytes = serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 1000n });
        // 1000 = 0x3e8 → 2-byte varint: 0x43 0xe8.
        expect(bytes).toEqual(new Uint8Array([0x07, 0x02, 0x43, 0xe8]));
    });

    it("MAX_PUSH_ID: type 0x0d + length + pushId varint (1-byte pushId)", () => {
        // pushId 50 < 64 → 1-byte varint.
        const bytes = serializeFrame({ type: Http3FrameType.MAX_PUSH_ID, pushId: 50n });
        expect(bytes).toEqual(new Uint8Array([0x0d, 0x01, 0x32]));
    });

    it("MAX_PUSH_ID: pushId 100 (≥ 64) uses a 2-byte varint", () => {
        // pushId 100 → 2-byte varint: 0x40 0x64.
        const bytes = serializeFrame({ type: Http3FrameType.MAX_PUSH_ID, pushId: 100n });
        expect(bytes).toEqual(new Uint8Array([0x0d, 0x02, 0x40, 0x64]));
    });

    it("unknown frame: rawType is emitted as the type varint, payload untouched", () => {
        const bytes = serializeFrame({
            type: HTTP3_UNKNOWN_FRAME_TYPE,
            rawType: 0x21,
            payload: new Uint8Array([0xaa]),
        } as Http3UnknownFrame);
        // type=0x21, length=0x01, payload=0xaa.
        expect(bytes).toEqual(new Uint8Array([0x21, 0x01, 0xaa]));
    });

    it("unknown frame with multi-byte rawType (> 63) encodes the type as a 2-byte varint", () => {
        // rawType 100 → 2-byte varint 0x40 0x64.
        const bytes = serializeFrame({
            type: HTTP3_UNKNOWN_FRAME_TYPE,
            rawType: 100,
            payload: new Uint8Array(0),
        } as Http3UnknownFrame);
        expect(bytes).toEqual(new Uint8Array([0x40, 0x64, 0x00]));
    });
});

// ===========================================================================
// FRAME SERIALIZATION — multi-byte length varint
// ===========================================================================

describe("serializeFrame — multi-byte length varint for large payloads", () => {
    it("DATA with 200-byte payload uses a 2-byte length varint", () => {
        const payload = new Uint8Array(200).fill(0x42);
        const bytes = serializeFrame({ type: Http3FrameType.DATA, payload });
        // type=0x00, length=200 → 2-byte varint: 0x40 0xc8.
        expect(bytes[0]).toBe(0x00); // type.
        expect(bytes[1]).toBe(0x40); // length high byte (prefix 01, 200 >> 8 = 0).
        expect(bytes[2]).toBe(0xc8); // length low byte (200 & 0xff).
        expect(bytes).toHaveLength(1 + 2 + 200);
    });

    it("DATA with exactly 64-byte payload triggers 2-byte length (length value 64)", () => {
        const payload = new Uint8Array(64);
        const bytes = serializeFrame({ type: Http3FrameType.DATA, payload });
        // length=64 → 2-byte varint: 0x40 0x40.
        expect(bytes[0]).toBe(0x00);
        expect(bytes[1]).toBe(0x40);
        expect(bytes[2]).toBe(0x40);
        expect(bytes).toHaveLength(1 + 2 + 64);
    });

    it("DATA with 63-byte payload keeps a 1-byte length", () => {
        const payload = new Uint8Array(63);
        const bytes = serializeFrame({ type: Http3FrameType.DATA, payload });
        // length=63 → 1-byte varint: 0x3f.
        expect(bytes[0]).toBe(0x00);
        expect(bytes[1]).toBe(0x3f);
        expect(bytes).toHaveLength(1 + 1 + 63);
    });
});

// ===========================================================================
// FRAME PARSING — every known variant round-trip with max values
// ===========================================================================

describe("parse — every variant round-trips at max varint values", () => {
    it("DATA round-trips a large payload", async () => {
        const payload = new Uint8Array(500).fill(0x77);
        const parsed = await roundTripOne({ type: Http3FrameType.DATA, payload });
        expect(parsed.type).toBe(Http3FrameType.DATA);
        if (parsed.type === Http3FrameType.DATA) {
            expect(parsed.payload).toEqual(payload);
        }
    });

    it("HEADERS round-trips a large QPACK block", async () => {
        const payload = new Uint8Array(500).fill(0x99);
        const parsed = await roundTripOne({ type: Http3FrameType.HEADERS, payload });
        if (parsed.type === Http3FrameType.HEADERS) {
            expect(parsed.payload).toEqual(payload);
        }
    });

    it("CANCEL_PUSH round-trips pushId = VARINT_MAX", async () => {
        const parsed = await roundTripOne({
            type: Http3FrameType.CANCEL_PUSH,
            pushId: VARINT_MAX,
        });
        if (parsed.type === Http3FrameType.CANCEL_PUSH) {
            expect(parsed.pushId).toBe(VARINT_MAX);
        }
    });

    it("GOAWAY round-trips streamId = VARINT_MAX", async () => {
        const parsed = await roundTripOne({
            type: Http3FrameType.GOAWAY,
            streamId: VARINT_MAX,
        });
        if (parsed.type === Http3FrameType.GOAWAY) {
            expect(parsed.streamId).toBe(VARINT_MAX);
        }
    });

    it("MAX_PUSH_ID round-trips pushId = VARINT_MAX", async () => {
        const parsed = await roundTripOne({
            type: Http3FrameType.MAX_PUSH_ID,
            pushId: VARINT_MAX,
        });
        if (parsed.type === Http3FrameType.MAX_PUSH_ID) {
            expect(parsed.pushId).toBe(VARINT_MAX);
        }
    });

    it("PUSH_PROMISE round-trips pushId = VARINT_MAX and large payload", async () => {
        const payload = new Uint8Array([0x01, 0x02, 0x03]);
        const parsed = await roundTripOne({
            type: Http3FrameType.PUSH_PROMISE,
            pushId: VARINT_MAX,
            payload,
        });
        if (parsed.type === Http3FrameType.PUSH_PROMISE) {
            expect(parsed.pushId).toBe(VARINT_MAX);
            expect(parsed.payload).toEqual(payload);
        }
    });
});

// ===========================================================================
// GREASE / unknown frames — ALL reserved ranges
// ===========================================================================

describe("GREASE / unknown frames — full reserved range coverage", () => {
    /**
     * RFC 9114 §7.1 + RFC 9000 §19.2: GREASE values are drawn from
     * {0x2, 0xb..0x1f, 0x21, 0x22, ...} — i.e. any type congruent to
     * (0xb + 0x1 * N) that isn't a defined frame type. The implementation
     * lumps all non-defined types into Http3UnknownFrame, which is the correct
     * behavior: reserved + GREASE are both ignored. Here we explicitly exercise
     * the boundaries of every reserved bucket.
     */
    // NOTE: 0x0d is deliberately excluded — it is MAX_PUSH_ID, a real frame
    // type. Every other value here is reserved/GREASE per RFC 9114 §7.1.
    const GREASE_TYPES: number[] = [
        0x2, // the sole reserved value below 0xb
        0xb, 0xc, 0xe, 0xf, // inside 0xb..0x1f
        0x10, 0x15, 0x1f, // inside 0xb..0x1f
        0x21, 0x22, 0x3f, // above 0x20
    ];

    it.each(GREASE_TYPES)("type 0x%02x is returned as Http3UnknownFrame with rawType preserved", async (rawType) => {
        const payload = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
        const bytes = concat(
            concat(encodeVarint(BigInt(rawType)), encodeVarint(BigInt(payload.length))),
            payload,
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        if (parsed.type === HTTP3_UNKNOWN_FRAME_TYPE) {
            expect(parsed.rawType).toBe(rawType);
            expect(parsed.payload).toEqual(payload);
        }
    });

    it("an unknown type with an empty payload parses as an empty unknown frame", async () => {
        const bytes = concat(
            concat(encodeVarint(0x21n), encodeVarint(0n)),
            new Uint8Array(0),
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        if (parsed.type === HTTP3_UNKNOWN_FRAME_TYPE) {
            expect(parsed.rawType).toBe(0x21);
            expect(parsed.payload).toHaveLength(0);
        }
    });

    it("a multi-byte GREASE type (> 63) is parsed correctly", async () => {
        // rawType 100 → 2-byte varint.
        const payload = new Uint8Array([0x01]);
        const typeVarint = encodeVarint(100n);
        const lengthVarint = encodeVarint(BigInt(payload.length));
        const bytes = concat(concat(typeVarint, lengthVarint), payload);
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        if (parsed.type === HTTP3_UNKNOWN_FRAME_TYPE) {
            expect(parsed.rawType).toBe(100);
            expect(parsed.payload).toEqual(payload);
        }
    });

    it("frames before and after a GREASE frame are unaffected (byte accounting)", async () => {
        const dataBefore = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([0xa1]) });
        const grease = concat(
            concat(encodeVarint(0x1fn), encodeVarint(2n)),
            new Uint8Array([0xb0, 0x0b]),
        );
        const goaway = serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 99n });
        const frames = await parseAll(concat(concat(dataBefore, grease), goaway));
        expect(frames).toHaveLength(3);
        expect(frames[0]!.type).toBe(Http3FrameType.DATA);
        expect(frames[1]!.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        expect(frames[2]!.type).toBe(Http3FrameType.GOAWAY);
        if (frames[0]!.type === Http3FrameType.DATA) {
            expect(frames[0]!.payload).toEqual(new Uint8Array([0xa1]));
        }
        if (frames[2]!.type === Http3FrameType.GOAWAY) {
            expect(frames[2]!.streamId).toBe(99n);
        }
    });

    it("multiple consecutive GREASE frames are all retained", async () => {
        const g1 = concat(
            concat(encodeVarint(0x2n), encodeVarint(1n)),
            new Uint8Array([0x01]),
        );
        const g2 = concat(
            concat(encodeVarint(0x21n), encodeVarint(1n)),
            new Uint8Array([0x02]),
        );
        const g3 = concat(
            concat(encodeVarint(0xbn), encodeVarint(1n)),
            new Uint8Array([0x03]),
        );
        const frames = await parseAll(concat(concat(g1, g2), g3));
        expect(frames).toHaveLength(3);
        for (const f of frames) {
            expect(f.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        }
        if (
            frames[0]!.type === HTTP3_UNKNOWN_FRAME_TYPE &&
            frames[1]!.type === HTTP3_UNKNOWN_FRAME_TYPE &&
            frames[2]!.type === HTTP3_UNKNOWN_FRAME_TYPE
        ) {
            expect(frames[0]!.rawType).toBe(0x2);
            expect(frames[1]!.rawType).toBe(0x21);
            expect(frames[2]!.rawType).toBe(0xb);
            expect(frames[0]!.payload).toEqual(new Uint8Array([0x01]));
            expect(frames[1]!.payload).toEqual(new Uint8Array([0x02]));
            expect(frames[2]!.payload).toEqual(new Uint8Array([0x03]));
        }
    });
});

// ===========================================================================
// SETTINGS — id filtering, duplicates, ordering, edge values
// ===========================================================================

describe("SETTINGS — id filtering and edge values", () => {
    it("retains all three known settings ids when all are present", async () => {
        const frame: Http3Frame = {
            type: Http3FrameType.SETTINGS,
            settings: {
                [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 1024,
                [Http3Settings.MAX_FIELD_SECTION_SIZE]: 16384,
                [Http3Settings.QPACK_BLOCKED_STREAMS]: 64,
            },
        };
        const parsed = await roundTripOne(frame);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(1024);
            expect(parsed.settings[Http3Settings.MAX_FIELD_SECTION_SIZE]).toBe(16384);
            expect(parsed.settings[Http3Settings.QPACK_BLOCKED_STREAMS]).toBe(64);
        }
    });

    it("filters out every unknown id in a mixed payload", async () => {
        // Known 0x1=10, unknown 0x0=1, unknown 0x2=2, unknown 0x8=3, unknown 0x21=4, known 0x7=5.
        const build = (...pairs: Array<[bigint, bigint]>): Bytes => {
            const parts: Bytes[] = [];
            for (const [id, value] of pairs) {
                parts.push(encodeVarint(id), encodeVarint(value));
            }
            return concatAllHelpers(parts);
        };
        const payload = build(
            [0x1n, 10n],
            [0x0n, 1n],
            [0x2n, 2n],
            [0x8n, 3n],
            [0x21n, 4n],
            [0x7n, 5n],
        );
        const bytes = concat(
            concat(encodeVarint(BigInt(Http3FrameType.SETTINGS)), encodeVarint(BigInt(payload.length))),
            payload,
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[0x1]).toBe(10);
            expect(parsed.settings[0x7]).toBe(5);
            expect(parsed.settings[0x0]).toBeUndefined();
            expect(parsed.settings[0x2]).toBeUndefined();
            expect(parsed.settings[0x8]).toBeUndefined();
            expect(parsed.settings[0x21]).toBeUndefined();
        }
    });

    it("duplicate known ids: the last write wins (object entries order)", async () => {
        // 0x1=100 then 0x1=200 — the encoder pushes both; the parser retains the
        // last decoded value for a repeated id (Map-like overwrite semantics).
        const payload = concatAllHelpers([
            encodeVarint(0x1n), encodeVarint(100n),
            encodeVarint(0x1n), encodeVarint(200n),
        ]);
        const bytes = concat(
            concat(encodeVarint(BigInt(Http3FrameType.SETTINGS)), encodeVarint(BigInt(payload.length))),
            payload,
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[0x1]).toBe(200);
        }
    });

    it("value 0 for a known id is retained", async () => {
        const payload = concatAllHelpers([encodeVarint(0x6n), encodeVarint(0n)]);
        const bytes = concat(
            concat(encodeVarint(BigInt(Http3FrameType.SETTINGS)), encodeVarint(BigInt(payload.length))),
            payload,
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[0x6]).toBe(0);
        }
    });

    it("a SETTINGS frame with only unknown ids decodes to an empty map", async () => {
        const payload = concatAllHelpers([
            encodeVarint(0x0n), encodeVarint(1n),
            encodeVarint(0x21n), encodeVarint(2n),
        ]);
        const bytes = concat(
            concat(encodeVarint(BigInt(Http3FrameType.SETTINGS)), encodeVarint(BigInt(payload.length))),
            payload,
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings).toEqual({});
        }
    });
});

/** concatAll mirror for local use (no import cycle). */
function concatAllHelpers(parts: Bytes[]): Bytes {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

// ===========================================================================
// FrameReader — chunk reassembly at every split point
// ===========================================================================

describe("FrameReader — chunk-split at every boundary", () => {
    it("reassembles a frame split across type | length | payload boundaries", async () => {
        const full = serializeFrame({
            type: Http3FrameType.DATA,
            payload: new Uint8Array([1, 2, 3, 4, 5]),
        });
        // Try every possible single split point.
        for (let split = 1; split < full.length; split++) {
            const chunk1 = full.subarray(0, split);
            const chunk2 = full.subarray(split);
            let call = 0;
            const reader = new FrameReader(async () => {
                call++;
                if (call === 1) return chunk1;
                if (call === 2) return chunk2;
                return new Uint8Array(0);
            });
            const frame = await reader.readFrame();
            expect(frame.type).toBe(Http3FrameType.DATA);
            if (frame.type === Http3FrameType.DATA) {
                expect(frame.payload).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
            }
        }
    });

    it("reassembles a frame delivered in many tiny chunks (3-byte payload)", async () => {
        const full = serializeFrame({
            type: Http3FrameType.DATA,
            payload: new Uint8Array([0xfa, 0xce, 0xba]),
        });
        // Deliver 2 bytes at a time.
        let pos = 0;
        const reader = new FrameReader(async () => {
            if (pos >= full.length) return new Uint8Array(0);
            const chunk = full.subarray(pos, pos + 2);
            pos += 2;
            return chunk;
        });
        const frame = await reader.readFrame();
        expect(frame.type).toBe(Http3FrameType.DATA);
        if (frame.type === Http3FrameType.DATA) {
            expect(frame.payload).toEqual(new Uint8Array([0xfa, 0xce, 0xba]));
        }
    });

    it("reads three frames in sequence from a single chunk", async () => {
        const f1 = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([10]) });
        const f2 = serializeFrame({ type: Http3FrameType.CANCEL_PUSH, pushId: 5n });
        const f3 = serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 100n });
        const all = concat(concat(f1, f2), f3);
        let emitted = false;
        const reader = new FrameReader(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return all;
        });
        const a = await reader.readFrame();
        const b = await reader.readFrame();
        const c = await reader.readFrame();
        expect(a.type).toBe(Http3FrameType.DATA);
        expect(b.type).toBe(Http3FrameType.CANCEL_PUSH);
        expect(c.type).toBe(Http3FrameType.GOAWAY);
        if (a.type === Http3FrameType.DATA) expect(a.payload).toEqual(new Uint8Array([10]));
        if (b.type === Http3FrameType.CANCEL_PUSH) expect(b.pushId).toBe(5n);
        if (c.type === Http3FrameType.GOAWAY) expect(c.streamId).toBe(100n);
    });

    it("reads frames across chunk boundaries: first chunk ends mid-frame, second has the rest + more", async () => {
        const f1 = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([1]) });
        const f2 = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([2]) });
        const f3 = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([3]) });
        const all = concat(concat(f1, f2), f3);
        // Split right after the first byte of f2.
        const split = f1.length + 1;
        const chunk1 = all.subarray(0, split);
        const chunk2 = all.subarray(split);
        let call = 0;
        const reader = new FrameReader(async () => {
            call++;
            if (call === 1) return chunk1;
            if (call === 2) return chunk2;
            return new Uint8Array(0);
        });
        const a = await reader.readFrame();
        const b = await reader.readFrame();
        const c = await reader.readFrame();
        expect(a.type).toBe(Http3FrameType.DATA);
        expect(b.type).toBe(Http3FrameType.DATA);
        expect(c.type).toBe(Http3FrameType.DATA);
        if (
            a.type === Http3FrameType.DATA &&
            b.type === Http3FrameType.DATA &&
            c.type === Http3FrameType.DATA
        ) {
            expect(a.payload).toEqual(new Uint8Array([1]));
            expect(b.payload).toEqual(new Uint8Array([2]));
            expect(c.payload).toEqual(new Uint8Array([3]));
        }
    });

    it("throws FrameParseError with offset 0 when the very first read is empty", async () => {
        const reader = new FrameReader(async () => new Uint8Array(0));
        await expect(reader.readFrame()).rejects.toThrow(FrameParseError);
    });

    it("throws FrameParseError when the stream ends mid-length", async () => {
        const full = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([1, 2, 3]) });
        // Truncate to just the type byte.
        const truncated = full.subarray(0, 1);
        let emitted = false;
        const reader = new FrameReader(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return truncated;
        });
        await expect(reader.readFrame()).rejects.toThrow(FrameParseError);
    });

    it("throws FrameParseError when the stream ends mid-payload", async () => {
        const full = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([1, 2, 3]) });
        // Truncate to type + length + 1 byte of payload (payload is 3 bytes).
        const truncated = full.subarray(0, 3);
        let emitted = false;
        const reader = new FrameReader(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return truncated;
        });
        await expect(reader.readFrame()).rejects.toThrow(FrameParseError);
    });

    it("FrameParseError carries the buffer-length offset", async () => {
        const reader = new FrameReader(async () => new Uint8Array(0));
        try {
            await reader.readFrame();
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(FrameParseError);
            expect((e as FrameParseError).offset).toBe(0);
            expect((e as FrameParseError).kind).toBe("FrameParseError");
        }
    });
});

// ===========================================================================
// readFrame standalone convenience wrapper
// ===========================================================================

describe("readFrame — standalone convenience wrapper", () => {
    it("reads a single DATA frame from a single-chunk source", async () => {
        const full = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([42]) });
        let emitted = false;
        const frame = await readFrame(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return full;
        });
        expect(frame.type).toBe(Http3FrameType.DATA);
        if (frame.type === Http3FrameType.DATA) {
            expect(frame.payload).toEqual(new Uint8Array([42]));
        }
    });

    it("reads a SETTINGS frame from a single-chunk source", async () => {
        const full = serializeFrame({
            type: Http3FrameType.SETTINGS,
            settings: { [Http3Settings.QPACK_BLOCKED_STREAMS]: 32 },
        });
        let emitted = false;
        const frame = await readFrame(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return full;
        });
        expect(frame.type).toBe(Http3FrameType.SETTINGS);
        if (frame.type === Http3FrameType.SETTINGS) {
            expect(frame.settings[Http3Settings.QPACK_BLOCKED_STREAMS]).toBe(32);
        }
    });
});

// ===========================================================================
// Round-trip field preservation — exhaustive per-variant assertions
// ===========================================================================

describe("round-trip — every field preserved exactly", () => {
    it("DATA: payload byte-for-byte", async () => {
        const payload = new Uint8Array([0x00, 0xff, 0x55, 0xaa]);
        const parsed = await roundTripOne({ type: Http3FrameType.DATA, payload });
        if (parsed.type === Http3FrameType.DATA) {
            expect(parsed.payload).toEqual(payload);
            expect(parsed.payload).toHaveLength(4);
        }
    });

    it("HEADERS: payload byte-for-byte", async () => {
        const payload = new Uint8Array([0x80, 0x00, 0x01, 0x02, 0x03]);
        const parsed = await roundTripOne({ type: Http3FrameType.HEADERS, payload });
        if (parsed.type === Http3FrameType.HEADERS) {
            expect(parsed.payload).toEqual(payload);
        }
    });

    it("CANCEL_PUSH: pushId preserved", async () => {
        const parsed = await roundTripOne({ type: Http3FrameType.CANCEL_PUSH, pushId: 42n });
        if (parsed.type === Http3FrameType.CANCEL_PUSH) {
            expect(parsed.pushId).toBe(42n);
        }
    });

    it("SETTINGS: every (id, value) pair preserved", async () => {
        const settings = {
            [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 8192,
            [Http3Settings.MAX_FIELD_SECTION_SIZE]: 65536,
            [Http3Settings.QPACK_BLOCKED_STREAMS]: 128,
        };
        const parsed = await roundTripOne({ type: Http3FrameType.SETTINGS, settings });
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings).toEqual(settings);
        }
    });

    it("PUSH_PROMISE: pushId + payload preserved", async () => {
        const payload = new Uint8Array([0x80, 0x01]);
        const parsed = await roundTripOne({ type: Http3FrameType.PUSH_PROMISE, pushId: 7n, payload });
        if (parsed.type === Http3FrameType.PUSH_PROMISE) {
            expect(parsed.pushId).toBe(7n);
            expect(parsed.payload).toEqual(payload);
        }
    });

    it("GOAWAY: streamId preserved", async () => {
        const parsed = await roundTripOne({ type: Http3FrameType.GOAWAY, streamId: 999n });
        if (parsed.type === Http3FrameType.GOAWAY) {
            expect(parsed.streamId).toBe(999n);
        }
    });

    it("MAX_PUSH_ID: pushId preserved", async () => {
        const parsed = await roundTripOne({ type: Http3FrameType.MAX_PUSH_ID, pushId: 255n });
        if (parsed.type === Http3FrameType.MAX_PUSH_ID) {
            expect(parsed.pushId).toBe(255n);
        }
    });
});

// ===========================================================================
// Mixed-frame sequences
// ===========================================================================

describe("mixed-frame sequences", () => {
    it("SETTINGS then DATA then GOAWAY parses in order", async () => {
        const frames = [
            serializeFrame({ type: Http3FrameType.SETTINGS, settings: { [Http3Settings.QPACK_BLOCKED_STREAMS]: 10 } }),
            serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([0x42]) }),
            serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 0n }),
        ];
        const parsed = await parseAll(concatAllHelpers(frames));
        expect(parsed).toHaveLength(3);
        expect(parsed[0]!.type).toBe(Http3FrameType.SETTINGS);
        expect(parsed[1]!.type).toBe(Http3FrameType.DATA);
        expect(parsed[2]!.type).toBe(Http3FrameType.GOAWAY);
    });

    it("GREASE interleaved between every known frame type", async () => {
        const grease = (rawType: number): Bytes =>
            concat(
                concat(encodeVarint(BigInt(rawType)), encodeVarint(0n)),
                new Uint8Array(0),
            );
        const known: Bytes[] = [
            serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([1]) }),
            serializeFrame({ type: Http3FrameType.HEADERS, payload: new Uint8Array([2]) }),
            serializeFrame({ type: Http3FrameType.CANCEL_PUSH, pushId: 0n }),
            serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }),
            serializeFrame({ type: Http3FrameType.PUSH_PROMISE, pushId: 0n, payload: new Uint8Array(0) }),
            serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 0n }),
            serializeFrame({ type: Http3FrameType.MAX_PUSH_ID, pushId: 0n }),
        ];
        // Interleave GREASE 0x21 between each known frame.
        const parts: Bytes[] = [];
        for (let i = 0; i < known.length; i++) {
            parts.push(known[i]!);
            parts.push(grease(0x21));
        }
        const parsed = await parseAll(concatAllHelpers(parts));
        // 7 known + 7 grease = 14.
        expect(parsed).toHaveLength(14);
        // Every odd index is GREASE.
        for (let i = 0; i < parsed.length; i++) {
            if (i % 2 === 1) {
                expect(parsed[i]!.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
            }
        }
        // Known frames are at even indices, in order.
        const knownTypes = [
            Http3FrameType.DATA,
            Http3FrameType.HEADERS,
            Http3FrameType.CANCEL_PUSH,
            Http3FrameType.SETTINGS,
            Http3FrameType.PUSH_PROMISE,
            Http3FrameType.GOAWAY,
            Http3FrameType.MAX_PUSH_ID,
        ];
        for (let i = 0; i < knownTypes.length; i++) {
            expect(parsed[i * 2]!.type).toBe(knownTypes[i]);
        }
    });
});
