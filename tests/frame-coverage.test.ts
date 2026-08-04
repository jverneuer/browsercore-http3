/**
 * Frame-layer coverage for @browsercore/http3.
 * Scope: src/frame/frame.ts and src/frame/varint.ts only.
 * The frame layer is fully implemented (see PLAN.md Steps 1-2).
 */
import { describe, it, expect } from "vitest";
import {
    decodeVarint, encodeVarint, FrameParseError, FrameReader,
    getVarintEncodedLength, HTTP3_UNKNOWN_FRAME_TYPE, Http3Error,
    Http3FrameType, Http3Settings, Http3StreamType, VARINT_MAX,
} from "../src/index.js";
import { readFrame, serializeFrame } from "../src/frame/frame.js";
import { concat } from "../src/utils.js";
import type {
    Http3Frame, Http3DataFrame, Http3HeadersFrame, Http3CancelPushFrame,
    Http3SettingsFrame, Http3PushPromiseFrame, Http3GoawayFrame, Http3MaxPushIdFrame,
    Http3UnknownFrame,
} from "../src/types.js";

const df = (p: Uint8Array): Http3DataFrame => ({ type: Http3FrameType.DATA, payload: p });
const hf = (p: Uint8Array): Http3HeadersFrame => ({ type: Http3FrameType.HEADERS, payload: p });
const cpf = (id: bigint): Http3CancelPushFrame => ({ type: Http3FrameType.CANCEL_PUSH, pushId: id });
const sf = (s: Http3SettingsFrame["settings"]): Http3SettingsFrame => ({ type: Http3FrameType.SETTINGS, settings: s });
const ppf = (id: bigint, p: Uint8Array): Http3PushPromiseFrame => ({ type: Http3FrameType.PUSH_PROMISE, pushId: id, payload: p });
const gf = (id: bigint): Http3GoawayFrame => ({ type: Http3FrameType.GOAWAY, streamId: id });
const mpf = (id: bigint): Http3MaxPushIdFrame => ({ type: Http3FrameType.MAX_PUSH_ID, pushId: id });

const EVERY_FRAME: Http3Frame[] = [
    df(new Uint8Array([0xde, 0xad])), hf(new Uint8Array([0xbe, 0xef])), cpf(0n),
    sf({ [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 1024 }), ppf(5n, new Uint8Array([0x01, 0x02])),
    gf(99n), mpf(50n),
];

async function parseAll(bytes: Uint8Array): Promise<Http3Frame[]> {
    let emitted = false;
    const reader = new FrameReader(async () => {
        if (emitted) return new Uint8Array(0);
        emitted = true;
        return bytes;
    });
    const out: Http3Frame[] = [];
    try { for (;;) out.push(await reader.readFrame()); } catch { /* done */ }
    return out;
}

async function roundTrip(frame: Http3Frame): Promise<void> {
    const parsed = await parseAll(serializeFrame(frame));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe(frame.type);
}

function oneShot(bytes: Uint8Array): () => Promise<Uint8Array> {
    let emitted = false;
    return async () => { if (emitted) return new Uint8Array(0); emitted = true; return bytes; };
}

describe("getVarintEncodedLength", () => {
    it("boundaries", () => {
        expect(getVarintEncodedLength(0n)).toBe(1);
        expect(getVarintEncodedLength((1n << 6n) - 1n)).toBe(1);
        expect(getVarintEncodedLength(1n << 6n)).toBe(2);
        expect(getVarintEncodedLength((1n << 14n) - 1n)).toBe(2);
        expect(getVarintEncodedLength(1n << 14n)).toBe(4);
        expect(getVarintEncodedLength((1n << 30n) - 1n)).toBe(4);
        expect(getVarintEncodedLength(1n << 30n)).toBe(8);
        expect(getVarintEncodedLength(VARINT_MAX)).toBe(8);
    });
    it("errors", () => {
        expect(() => getVarintEncodedLength(-1n)).toThrow(RangeError);
        expect(() => getVarintEncodedLength(VARINT_MAX + 1n)).toThrow(RangeError);
    });
    it("output space is {1,2,4,8}", () => {
        const allowed = new Set([1, 2, 4, 8]);
        for (const v of [0n, 1n, 63n, 64n, 16383n, 16384n, 1_000_000n, (1n << 30n) - 1n, 1n << 30n, VARINT_MAX]) {
            expect(allowed.has(getVarintEncodedLength(v))).toBe(true);
        }
    });
});

describe("varint encode", () => {
    it("0x0", () => { expect(encodeVarint(0x0n)).toEqual(new Uint8Array([0])); });
    it("0x3f", () => { expect(encodeVarint(0x3fn)).toEqual(new Uint8Array([0x3f])); });
    it("0x40", () => { expect(encodeVarint(0x40n)).toEqual(new Uint8Array([0x40, 0x40])); });
    it("0x3fff", () => { expect(encodeVarint(0x3fffn)).toEqual(new Uint8Array([0x7f, 0xff])); });
    it("0x4000", () => { expect(encodeVarint(0x4000n)).toEqual(new Uint8Array([0x80, 0x00, 0x40, 0x00])); });
    it("VARINT_MAX", () => { expect(encodeVarint(VARINT_MAX)).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])); });
});

describe("varint decode", () => {
    it("1-byte", () => { expect(decodeVarint(new Uint8Array([0x2a]))).toEqual({ value: 0x2an, length: 1 }); });
    it("2-byte", () => { expect(decodeVarint(new Uint8Array([0x40, 0x7b]))).toEqual({ value: 0x7bn, length: 2 }); });
    it("4-byte", () => { expect(decodeVarint(new Uint8Array([0x80, 0x00, 0x12, 0x34]))).toEqual({ value: 0x1234n, length: 4 }); });
    it("trailing bytes ignored", () => { expect(decodeVarint(new Uint8Array([0x05, 0xff, 0xff]).subarray(0, 1))).toEqual({ value: 5n, length: 1 }); });
});

describe("varint round-trip", () => {
    it("boundaries", () => {
        for (const v of [0n, (1n << 6n) - 1n, 1n << 6n, (1n << 14n) - 1n, 1n << 14n, (1n << 30n) - 1n, 1n << 30n, VARINT_MAX]) {
            expect(decodeVarint(encodeVarint(v)).value).toBe(v);
        }
    });
});

describe("varint errors", () => {
    it("empty", () => { expect(() => decodeVarint(new Uint8Array())).toThrow(RangeError); });
    it("truncated", () => { expect(() => decodeVarint(new Uint8Array([0x40]))).toThrow(RangeError); });
    it("negative", () => { expect(() => encodeVarint(-1n)).toThrow(RangeError); });
    it("overflow", () => { expect(() => encodeVarint(VARINT_MAX + 1n)).toThrow(RangeError); });
});

describe("frame serialization", () => {
    it("DATA", () => { expect(serializeFrame(df(new Uint8Array([0xca, 0xfe])))).toEqual(new Uint8Array([0x00, 0x02, 0xca, 0xfe])); });
    it("HEADERS", () => { expect(serializeFrame(hf(new Uint8Array([0x03, 0x04])))).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04])); });
    it("CANCEL_PUSH", () => { expect(serializeFrame(cpf(256n))).toEqual(new Uint8Array([0x03, 0x02, 0x41, 0x00])); });
    it("SETTINGS", () => { expect(serializeFrame(sf({ [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 1024 }))).toEqual(new Uint8Array([0x04, 0x03, 0x01, 0x44, 0x00])); });
    it("PUSH_PROMISE", () => { expect(serializeFrame(ppf(8n, new Uint8Array([0x10])))).toEqual(new Uint8Array([0x05, 0x02, 0x08, 0x10])); });
    it("GOAWAY", () => { expect(serializeFrame(gf(12345n))).toEqual(new Uint8Array([0x07, 0x02, 0x70, 0x39])); });
    it("MAX_PUSH_ID", () => { expect(serializeFrame(mpf(50n))).toEqual(new Uint8Array([0x0d, 0x01, 0x32])); });
    it("empty DATA", () => { expect(serializeFrame(df(new Uint8Array()))).toEqual(new Uint8Array([0x00, 0x00])); });
    it("empty SETTINGS", () => { expect(serializeFrame(sf({}))).toEqual(new Uint8Array([0x04, 0x00])); });
    it("large payload multi-byte length", () => {
        const b = serializeFrame(df(new Uint8Array(200).fill(0xab)));
        expect(b[0]).toBe(0x00); expect(b[1]).toBe(0x40); expect(b[2]).toBe(0xc8); expect(b).toHaveLength(203);
    });
    it("SETTINGS order preserved", () => {
        expect(serializeFrame(sf({ [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 50, [Http3Settings.QPACK_BLOCKED_STREAMS]: 10 })))
            .toEqual(new Uint8Array([0x04, 0x04, 0x01, 0x32, 0x07, 0x0a]));
    });
    it("unknown frame serializes via rawType", () => {
        // Exercises frameTypeCode's HTTP3_UNKNOWN_FRAME_TYPE branch (frame.ts:83):
        // the wire `type` comes from rawType, not the discriminant.
        const frame: Http3UnknownFrame = { type: HTTP3_UNKNOWN_FRAME_TYPE, rawType: 0x2, payload: new Uint8Array([0xaa, 0xbb]) };
        expect(serializeFrame(frame)).toEqual(new Uint8Array([0x02, 0x02, 0xaa, 0xbb]));
    });
    it("skips undefined SETTINGS values defensively", () => {
        // Object.entries yields `number | undefined` on a Partial record. Inject an
        // undefined value to exercise the `typeof value !== "number"` skip branch.
        const frame: Http3SettingsFrame = { type: Http3FrameType.SETTINGS, settings: {} };
        (frame.settings as Record<number, number | undefined>)[Http3Settings.QPACK_MAX_TABLE_CAPACITY] = undefined;
        expect(serializeFrame(frame)).toEqual(new Uint8Array([0x04, 0x00]));
    });
    it("throws on an unhandled frame type (exhaustiveness guard)", () => {
        // All legitimate Http3Frame variants are handled; reach the default branch
        // (the `never` exhaustiveness guard) by feeding an unrecognized type.
        const badFrame = { type: 0x99, payload: new Uint8Array() } as any as Http3Frame;
        expect(() => serializeFrame(badFrame)).toThrow(/unhandled frame type/);
    });
});

describe("frame parsing round-trips", () => {
    it("DATA", async () => { await roundTrip(df(new Uint8Array([0xde, 0xad]))); });
    it("HEADERS", async () => { await roundTrip(hf(new Uint8Array([0xbe, 0xef]))); });
    it("CANCEL_PUSH", async () => { await roundTrip(cpf(256n)); });
    it("SETTINGS empty", async () => { await roundTrip(sf({})); });
    it("SETTINGS one", async () => {
        const p = (await parseAll(serializeFrame(sf({ [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 1024 }))))[0]!;
        if (p.type === Http3FrameType.SETTINGS) expect(p.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(1024);
    });
    it("SETTINGS multiple", async () => {
        const p = (await parseAll(serializeFrame(sf({ [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096, [Http3Settings.QPACK_BLOCKED_STREAMS]: 16 }))))[0]!;
        if (p.type === Http3FrameType.SETTINGS) {
            expect(p.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(4096);
            expect(p.settings[Http3Settings.QPACK_BLOCKED_STREAMS]).toBe(16);
        }
    });
    it("PUSH_PROMISE", async () => {
        const p = (await parseAll(serializeFrame(ppf(8n, new Uint8Array([0x10, 0x11])))))[0]!;
        if (p.type === Http3FrameType.PUSH_PROMISE) { expect(p.pushId).toBe(8n); expect(p.payload).toEqual(new Uint8Array([0x10, 0x11])); }
    });
    it("GOAWAY", async () => { const p = (await parseAll(serializeFrame(gf(12345n))))[0]!; if (p.type === Http3FrameType.GOAWAY) expect(p.streamId).toBe(12345n); });
    it("MAX_PUSH_ID", async () => { const p = (await parseAll(serializeFrame(mpf(50n))))[0]!; if (p.type === Http3FrameType.MAX_PUSH_ID) expect(p.pushId).toBe(50n); });
    it("all variants", async () => { for (const f of EVERY_FRAME) await roundTrip(f); });
});

describe("multi-byte varint handling", () => {
    it("push_id > 0x3f", async () => {
        const p = (await parseAll(serializeFrame(mpf(1000n))))[0]!;
        if (p.type === Http3FrameType.MAX_PUSH_ID) expect(p.pushId).toBe(1000n);
    });
    it("length > 0x3f", async () => {
        const p = (await parseAll(serializeFrame(df(new Uint8Array(200).fill(0x42)))))[0]!;
        if (p.type === Http3FrameType.DATA) expect(p.payload).toHaveLength(200);
    });
    it("consumes exactly frame bytes", async () => {
        const bytes = serializeFrame(df(new Uint8Array([0xca, 0xfe])));
        const withSentinel = concat(bytes, new Uint8Array([0xff]));
        let pos = 0;
        const f = await readFrame(async () => {
            if (pos >= withSentinel.length) return new Uint8Array(0);
            return withSentinel.subarray(pos, pos + 1);
        });
        expect(f.type).toBe(Http3FrameType.DATA);
    });
    it("leaves trailing bytes", async () => {
        const bytes = concat(serializeFrame(df(new Uint8Array([1]))), serializeFrame(gf(7n)));
        let emitted = false;
        const reader = new FrameReader(async () => { if (emitted) return new Uint8Array(0); emitted = true; return bytes; });
        const f1 = await reader.readFrame();
        const f2 = await reader.readFrame();
        expect(f1.type).toBe(Http3FrameType.DATA);
        if (f2.type === Http3FrameType.GOAWAY) expect(f2.streamId).toBe(7n);
    });
});

describe("FrameReader reassembly", () => {
    it("byte-by-byte", async () => {
        const full = serializeFrame(df(new Uint8Array([9, 8, 7])));
        let pos = 0;
        const reader = new FrameReader(async () => {
            if (pos >= full.length) return new Uint8Array(0);
            const chunk = full.subarray(pos, pos + 1);
            pos += 1;
            return chunk;
        });
        const p = await reader.readFrame();
        if (p.type === Http3FrameType.DATA) expect(p.payload).toEqual(new Uint8Array([9, 8, 7]));
    });
    it("surplus across frames", async () => {
        const both = concat(serializeFrame(df(new Uint8Array([1]))), serializeFrame(gf(7n)));
        let emitted = false;
        const reader = new FrameReader(async () => { if (emitted) return new Uint8Array(0); emitted = true; return both; });
        const f1 = await reader.readFrame();
        const f2 = await reader.readFrame();
        expect(f1.type).toBe(Http3FrameType.DATA);
        if (f2.type === Http3FrameType.GOAWAY) expect(f2.streamId).toBe(7n);
    });
});

describe("frame error paths", () => {
    it("empty reader", async () => { await expect(readFrame(async () => new Uint8Array(0))).rejects.toThrow(FrameParseError); });
    it("truncated type", async () => { await expect(readFrame(oneShot(new Uint8Array([0x80])))).rejects.toThrow(FrameParseError); });
    it("truncated length", async () => { await expect(readFrame(oneShot(new Uint8Array([0x00, 0x80])))).rejects.toThrow(FrameParseError); });
    it("truncated payload", async () => { await expect(readFrame(oneShot(new Uint8Array([0x00, 0x0a, 0x01, 0x02])))).rejects.toThrow(FrameParseError); });
    it("truncated SETTINGS", async () => { await expect(readFrame(oneShot(new Uint8Array([0x04, 0x03, 0x01])))).rejects.toThrow(FrameParseError); });
    it("truncated CANCEL_PUSH", async () => { await expect(readFrame(oneShot(new Uint8Array([0x03, 0x02, 0x40])))).rejects.toThrow(FrameParseError); });
    it("truncated GOAWAY", async () => { await expect(readFrame(oneShot(new Uint8Array([0x07, 0x04, 0x80])))).rejects.toThrow(FrameParseError); });
    it("truncated MAX_PUSH_ID", async () => { await expect(readFrame(oneShot(new Uint8Array([0x0d, 0x08, 0xc0])))).rejects.toThrow(FrameParseError); });
    it("frame length exceeding MAX_SAFE_INTEGER throws FrameParseError", async () => {
        // The length varint encodes a value > Number.MAX_SAFE_INTEGER. readBytes
        // must reject it (the only remaining MAX_SAFE_INTEGER guard after the
        // redundant readFrame check was removed). An 8-byte varint with the top
        // prefix decodes to a value in [2^62-2^56, 2^62-1], all > MAX_SAFE_INTEGER.
        const typeVarint = encodeVarint(BigInt(Http3FrameType.DATA));
        const hugeLength = new Uint8Array([0xc0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        const bytes = concat(typeVarint, hugeLength);
        await expect(readFrame(oneShot(bytes))).rejects.toThrow(FrameParseError);
    });
});

describe("GREASE frames (RFC 9114 §7.1, §7.2.8)", () => {
    it("type 0x2 returned as unknown", async () => {
        const g = concat(encodeVarint(0x2n), concat(encodeVarint(1n), new Uint8Array([0xff])));
        expect((await parseAll(g))[0]!.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
    });
    it("type 0x0b returned as unknown", async () => {
        const g = concat(encodeVarint(0x0bn), concat(encodeVarint(0n), new Uint8Array()));
        expect((await parseAll(g))[0]!.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
    });
    it("type 0x21 is skipped", async () => {
        const g = concat(encodeVarint(0x21n), concat(encodeVarint(1n), new Uint8Array([0xff])));
        const frames = await parseAll(concat(g, serializeFrame(df(new Uint8Array([1])))));
        expect(frames).toHaveLength(1);
        expect(frames[0]!.type).toBe(Http3FrameType.DATA);
    });
    it("interleaved DATA + 0x2 + 0x21 parses only DATA and 0x2", async () => {
        const d = serializeFrame(df(new Uint8Array([5])));
        const g2 = concat(encodeVarint(0x2n), concat(encodeVarint(1n), new Uint8Array([0xff])));
        const g21 = concat(encodeVarint(0x21n), concat(encodeVarint(1n), new Uint8Array([0xee])));
        const frames = await parseAll(concat(concat(d, g2), g21));
        expect(frames).toHaveLength(2);
        expect(frames[0]!.type).toBe(Http3FrameType.DATA);
        expect(frames[1]!.type).toBe(HTTP3_UNKNOWN_FRAME_TYPE);
    });
    it("only GREASE frames yields no parseable frames", async () => {
        const g21 = concat(encodeVarint(0x21n), concat(encodeVarint(0n), new Uint8Array()));
        const g40 = concat(encodeVarint(0x40n), concat(encodeVarint(0n), new Uint8Array()));
        const frames = await parseAll(concat(g21, g40));
        expect(frames).toHaveLength(0);
    });
});

describe("constant tables", () => {
    it("frame types", () => {
        expect(Http3FrameType.DATA).toBe(0x0); expect(Http3FrameType.HEADERS).toBe(0x1);
        expect(Http3FrameType.CANCEL_PUSH).toBe(0x3); expect(Http3FrameType.SETTINGS).toBe(0x4);
        expect(Http3FrameType.PUSH_PROMISE).toBe(0x5); expect(Http3FrameType.GOAWAY).toBe(0x7);
        expect(Http3FrameType.MAX_PUSH_ID).toBe(0x0d);
    });
    it("settings", () => {
        expect(Http3Settings.QPACK_MAX_TABLE_CAPACITY).toBe(0x1);
        expect(Http3Settings.MAX_FIELD_SECTION_SIZE).toBe(0x6);
        expect(Http3Settings.QPACK_BLOCKED_STREAMS).toBe(0x7);
    });
    it("stream types", () => {
        expect(Http3StreamType.CONTROL).toBe(0x0); expect(Http3StreamType.PUSH).toBe(0x1);
        expect(Http3StreamType.QPACK_ENCODER).toBe(0x2); expect(Http3StreamType.QPACK_DECODER).toBe(0x3);
    });
    it("VARINT_MAX", () => { expect(VARINT_MAX).toBe((1n << 62n) - 1n); });
});

describe("FrameParseError", () => {
    it("offset", () => { expect(new FrameParseError(42).offset).toBe(42); });
    it("instanceof Http3Error", () => { expect(new FrameParseError(0)).toBeInstanceOf(Http3Error); });
    it("cause", () => { const c = new RangeError("x"); expect(new FrameParseError(1, { cause: c }).cause).toBe(c); });
});
