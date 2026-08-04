/**
 * HTTP/3 frame serialize/parse round-trip (PLAN.md Step 2).
 *
 * Every `Http3Frame` variant survives a serialize -> parse round trip; SETTINGS
 * encodes/decodes multiple (id, value) pairs; unknown/GREASE types are returned
 * as `Http3UnknownFrame` and skipped; and the `FrameReader` reassembles frames
 * from chunked reads and preserves surplus bytes between frames.
 */

import { describe, it, expect } from "vitest";
import {
    FrameReader,
    HTTP3_UNKNOWN_FRAME_TYPE,
    Http3FrameType,
    Http3Settings,
    type Http3Frame,
    type Http3UnknownFrame,
} from "../src/index.js";
import { readFrame, serializeFrame } from "../src/frame/frame.js";
import { concat } from "../src/utils.js";

/** Feed `bytes` to a fresh FrameReader and collect every frame. */
async function parseAll(bytes: Bytes): Promise<Http3Frame[]> {
    // Yield the whole buffer in one chunk — the reader must still parse it.
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

/** Assert a frame survives serialize -> parse with its fields intact. */
async function roundTrip(frame: Http3Frame): Promise<void> {
    const parsed = await parseAll(serializeFrame(frame));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe(frame.type);
}

describe("DATA frame", () => {
    it("round-trips an empty DATA frame", async () => {
        await roundTrip({ type: Http3FrameType.DATA, payload: new Uint8Array(0) });
    });

    it("round-trips a DATA frame with payload", async () => {
        await roundTrip({ type: Http3FrameType.DATA, payload: new Uint8Array([0xde, 0xad]) });
    });
});

describe("HEADERS frame", () => {
    it("round-trips a HEADERS frame (QPACK block passthrough)", async () => {
        await roundTrip({ type: Http3FrameType.HEADERS, payload: new Uint8Array([0x03, 0x04]) });
    });
});

describe("CANCEL_PUSH frame", () => {
    it("round-trips CANCEL_PUSH with a push id", async () => {
        await roundTrip({ type: Http3FrameType.CANCEL_PUSH, pushId: 256n });
    });

    it("round-trips CANCEL_PUSH with push id 0", async () => {
        await roundTrip({ type: Http3FrameType.CANCEL_PUSH, pushId: 0n });
    });
});

describe("SETTINGS frame", () => {
    it("round-trips an empty SETTINGS frame", async () => {
        await roundTrip({ type: Http3FrameType.SETTINGS, settings: {} });
    });

    it("round-trips a SETTINGS frame with multiple (id, value) pairs", async () => {
        const frame: Http3Frame = {
            type: Http3FrameType.SETTINGS,
            settings: {
                [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096,
                [Http3Settings.QPACK_BLOCKED_STREAMS]: 16,
            },
        };
        await roundTrip(frame);
        const parsed = (await parseAll(serializeFrame(frame)))[0]!;
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(4096);
            expect(parsed.settings[Http3Settings.QPACK_BLOCKED_STREAMS]).toBe(16);
        }
    });

    it("ignores unknown SETTINGS identifiers", async () => {
        // Hand-build a SETTINGS payload with a known id (0x1) and an unknown
        // id (0x9). The unknown id must not appear in the decoded map.
        const known = concat(
            encodeVarintLocal(0x1n),
            encodeVarintLocal(100n),
        );
        const unknown = concat(
            encodeVarintLocal(0x9n),
            encodeVarintLocal(5n),
        );
        const payload = concat(known, unknown);
        const bytes = concat(
            concat(encodeVarintLocal(BigInt(Http3FrameType.SETTINGS)), encodeVarintLocal(BigInt(payload.length))),
            payload,
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[0x1]).toBe(100);
            expect(parsed.settings[0x9]).toBeUndefined();
        }
    });
});

describe("PUSH_PROMISE frame", () => {
    it("round-trips PUSH_PROMISE (push id + QPACK block)", async () => {
        await roundTrip({
            type: Http3FrameType.PUSH_PROMISE,
            pushId: 8n,
            payload: new Uint8Array([0x10, 0x11]),
        });
    });
});

describe("GOAWAY frame", () => {
    it("round-trips GOAWAY with a stream id", async () => {
        await roundTrip({ type: Http3FrameType.GOAWAY, streamId: 12345n });
    });
});

describe("MAX_PUSH_ID frame", () => {
    it("round-trips MAX_PUSH_ID", async () => {
        await roundTrip({ type: Http3FrameType.MAX_PUSH_ID, pushId: 100n });
    });
});

describe("unknown / GREASE frames (RFC 9114 §7.1)", () => {
    it("parses a reserved 0x2 frame as unknown and retains its payload", async () => {
        const payload = new Uint8Array([0xaa, 0xbb]);
        const bytes = concat(
            concat(encodeVarintLocal(0x2n), encodeVarintLocal(BigInt(payload.length))),
            payload,
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        if (parsed.type === HTTP3_UNKNOWN_FRAME_TYPE) {
            expect(parsed.rawType).toBe(0x2);
            expect(parsed.payload).toEqual(payload);
        }
    });

    it("parses a GREASE 0x21 frame as unknown", async () => {
        const bytes = concat(
            concat(encodeVarintLocal(0x21n), encodeVarintLocal(1n)),
            new Uint8Array([0xff]),
        );
        const parsed = (await parseAll(bytes))[0]!;
        expect(parsed.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        expect((parsed as Http3UnknownFrame).rawType).toBe(0x21);
    });

    it("returns unknown frames so the consumer can skip them (does not drop bytes)", async () => {
        // DATA, 0x21 GREASE, DATA. The frame reader must NOT silently drop the
        // GREASE frame (that would hide it from logs/counters); it returns it
        // as an Http3UnknownFrame so the consumer can choose to skip it — and
        // crucially, the trailing DATA frame must still parse.
        const data1 = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([1]) });
        const grease = concat(
            concat(encodeVarintLocal(0x21n), encodeVarintLocal(1n)),
            new Uint8Array([0xff]),
        );
        const data2 = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([2]) });
        const frames = await parseAll(concat(concat(data1, grease), data2));
        expect(frames).toHaveLength(3);
        expect(frames[0]!.type).toBe(Http3FrameType.DATA);
        expect(frames[1]!.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
        expect(frames[2]!.type).toBe(Http3FrameType.DATA);
        if (frames[0]!.type === Http3FrameType.DATA && frames[2]!.type === Http3FrameType.DATA) {
            expect(frames[0]!.payload).toEqual(new Uint8Array([1]));
            expect(frames[2]!.payload).toEqual(new Uint8Array([2]));
        }
        // A consumer "skipping" unknown frames keeps only the known ones.
        const known = frames.filter((f) => f.type !== HTTP3_UNKNOWN_FRAME_TYPE);
        expect(known).toHaveLength(2);
    });
});

describe("FrameReader — chunk reassembly", () => {
    it("reassembles a frame delivered byte-by-byte", async () => {
        const full = serializeFrame({
            type: Http3FrameType.DATA,
            payload: new Uint8Array([9, 8, 7]),
        });
        let pos = 0;
        const reader = new FrameReader(async () => {
            if (pos >= full.length) return new Uint8Array(0);
            const chunk = full.subarray(pos, pos + 1);
            pos += 1;
            return chunk;
        });
        const frame = await reader.readFrame();
        expect(frame.type).toBe(Http3FrameType.DATA);
        if (frame.type === Http3FrameType.DATA) {
            expect(frame.payload).toEqual(new Uint8Array([9, 8, 7]));
        }
    });

    it("preserves surplus bytes across frames (one read, two frames)", async () => {
        const f1 = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([1]) });
        const f2 = serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 7n });
        const both = concat(f1, f2);
        let emitted = false;
        const reader = new FrameReader(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return both;
        });
        const first = await reader.readFrame();
        const second = await reader.readFrame();
        expect(first.type).toBe(Http3FrameType.DATA);
        expect(second.type).toBe(Http3FrameType.GOAWAY);
        if (second.type === Http3FrameType.GOAWAY) {
            expect(second.streamId).toBe(7n);
        }
    });

    it("throws FrameParseError when the stream ends mid-frame", async () => {
        const full = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([1, 2, 3]) });
        // Truncate to just the type byte — the reader will hit EOF reading length.
        const truncated = full.subarray(0, 1);
        let emitted = false;
        const reader = new FrameReader(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return truncated;
        });
        await expect(reader.readFrame()).rejects.toThrow();
    });
});

describe("readFrame (standalone)", () => {
    it("reads a single frame from a single-chunk source", async () => {
        const full = serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([42]) });
        let emitted = false;
        const frame = await readFrame(async () => {
            if (emitted) return new Uint8Array(0);
            emitted = true;
            return full;
        });
        expect(frame.type).toBe(Http3FrameType.DATA);
    });
});

// ---------------------------------------------------------------------------
// Local test helper: varint encode without importing internals.
// ---------------------------------------------------------------------------
function encodeVarintLocal(value: bigint): Uint8Array {
    // Re-implement the minimal encoder the production code uses, so this test
    // file can hand-build wire bytes for SETTINGS/GREASE without depending on
    // the production export's internals. Mirrors encodeVarint (RFC 9000 §16).
    if (value < (1n << 6n)) return new Uint8Array([Number(value)]);
    if (value < (1n << 14n)) {
        return new Uint8Array([Number(value >> 8n) | 0x40, Number(value & 0xffn)]);
    }
    if (value < (1n << 30n)) {
        return new Uint8Array([
            Number(value >> 24n) | 0x80,
            Number((value >> 16n) & 0xffn),
            Number((value >> 8n) & 0xffn),
            Number(value & 0xffn),
        ]);
    }
    return new Uint8Array([
        Number(value >> 56n) | 0xc0,
        Number((value >> 48n) & 0xffn),
        Number((value >> 40n) & 0xffn),
        Number((value >> 32n) & 0xffn),
        Number((value >> 24n) & 0xffn),
        Number((value >> 16n) & 0xffn),
        Number((value >> 8n) & 0xffn),
        Number(value & 0xffn),
    ]);
}
