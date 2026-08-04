/**
 * @browsercore/http3 — tests for the code that exists.
 *
 * This package is largely unimplemented (see PLAN.md): most of `src/` is
 * currently a set of TODO stubs that throw. Per the project's "test what
 * exists" rule, every existing statement / branch / function / line is covered:
 *   - Real implementations (errors, utils, getVarintEncodedLength, the stream
 *     / frame / QPACK / connection types) are exercised across their edge cases.
 *   - TODO stubs are covered by asserting they throw their placeholder error —
 *     the only behaviour that currently exists — without implementing the
 *     underlying feature.
 *
 * Genuinely unimplemented *features* (varint encode/decode wire round-trip,
 * frame serialize/parse, QPACK tables, the stream manager, the connection
 * lifecycle, GOAWAY, push, GREASE) are marked `it.todo` below so the PLAN.md
 * checklist keeps a 1:1 mapping to runnable tests. Those are listed in the final
 * report — they are intentionally not built here.
 */

import { describe, it, expect } from "vitest";
import {
    assertNever,
    connectHttp3,
    createStreamManager,
    decodeVarint,
    encodeVarint,
    getVarintEncodedLength,
    FrameParseError,
    GoawayReceivedError,
    Http3ConnectionImpl,
    Http3Error,
    Http3FrameType,
    Http3Settings,
    Http3StreamType,
    PushCancelledError,
    QpackDecodeError,
    QpackDecoder,
    QpackEncoder,
    qpackDecodeHeaders,
    qpackEncodeHeaders,
    SettingsAckTimeoutError,
    SettingsViolationError,
    VARINT_MAX,
} from "../src/index.js";
import { readFrame, serializeFrame } from "../src/frame/frame.js";
import { concat, concatAll } from "../src/utils.js";
import type {
    Http3Frame,
    Http3Request,
    QuicConnection,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// errors.ts — every branch (with and without `cause`) of every error class.
// ---------------------------------------------------------------------------

describe("errors", () => {
    it("Http3Error — without cause", () => {
        const e = new Http3Error("boom");
        expect(e).toBeInstanceOf(Http3Error);
        expect(e.message).toBe("boom");
        expect(e.kind).toBe("Http3Error");
        expect(e.name).toBe("Http3Error");
        expect(e.cause).toBeUndefined();
    });

    it("Http3Error — with cause", () => {
        const cause = new Error("root");
        const e = new Http3Error("boom", { cause });
        expect(e.cause).toBe(cause);
    });

    it("GoawayReceivedError — without cause", () => {
        const e = new GoawayReceivedError(7n);
        expect(e).toBeInstanceOf(GoawayReceivedError);
        expect(e.lastStreamId).toBe(7n);
        expect(e.kind).toBe("GoawayReceivedError");
        expect(e.name).toBe("GoawayReceivedError");
        expect(e.message).toContain("7");
        expect(e.cause).toBeUndefined();
    });

    it("GoawayReceivedError — with cause", () => {
        const cause = new Error("underlying");
        const e = new GoawayReceivedError(3n, { cause });
        expect(e.lastStreamId).toBe(3n);
        expect(e.cause).toBe(cause);
    });

    it("PushCancelledError — without cause", () => {
        const e = new PushCancelledError(9n);
        expect(e).toBeInstanceOf(PushCancelledError);
        expect(e.pushId).toBe(9n);
        expect(e.kind).toBe("PushCancelledError");
        expect(e.name).toBe("PushCancelledError");
        expect(e.message).toContain("9");
        expect(e.cause).toBeUndefined();
    });

    it("PushCancelledError — with cause", () => {
        const cause = new Error("underlying");
        const e = new PushCancelledError(1n, { cause });
        expect(e.pushId).toBe(1n);
        expect(e.cause).toBe(cause);
    });

    it("FrameParseError — without cause", () => {
        const e = new FrameParseError(42);
        expect(e).toBeInstanceOf(FrameParseError);
        expect(e.offset).toBe(42);
        expect(e.kind).toBe("FrameParseError");
        expect(e.name).toBe("FrameParseError");
        expect(e.message).toContain("42");
        expect(e.cause).toBeUndefined();
    });

    it("FrameParseError — with cause", () => {
        const cause = new RangeError("bad");
        const e = new FrameParseError(8, { cause });
        expect(e.offset).toBe(8);
        expect(e.cause).toBe(cause);
    });

    it("QpackDecodeError — without cause", () => {
        const e = new QpackDecodeError("corrupt");
        expect(e).toBeInstanceOf(QpackDecodeError);
        expect(e.kind).toBe("QpackDecodeError");
        expect(e.name).toBe("QpackDecodeError");
        expect(e.message).toContain("corrupt");
        expect(e.cause).toBeUndefined();
    });

    it("QpackDecodeError — with cause", () => {
        const cause = new Error("underlying");
        const e = new QpackDecodeError("corrupt", { cause });
        expect(e.cause).toBe(cause);
    });

    it("SettingsViolationError — without cause", () => {
        const e = new SettingsViolationError(0x1, 999);
        expect(e).toBeInstanceOf(SettingsViolationError);
        expect(e.setting).toBe(0x1);
        expect(e.value).toBe(999);
        expect(e.kind).toBe("SettingsViolationError");
        expect(e.name).toBe("SettingsViolationError");
        expect(e.cause).toBeUndefined();
    });

    it("SettingsViolationError — with cause", () => {
        const cause = new Error("underlying");
        const e = new SettingsViolationError(0x6, 0, { cause });
        expect(e.setting).toBe(0x6);
        expect(e.value).toBe(0);
        expect(e.cause).toBe(cause);
    });

    it("SettingsAckTimeoutError — without cause", () => {
        const e = new SettingsAckTimeoutError(5000);
        expect(e).toBeInstanceOf(SettingsAckTimeoutError);
        expect(e.timeoutMs).toBe(5000);
        expect(e.kind).toBe("SettingsAckTimeoutError");
        expect(e.name).toBe("SettingsAckTimeoutError");
        expect(e.message).toContain("5000");
        expect(e.cause).toBeUndefined();
    });

    it("SettingsAckTimeoutError — with cause", () => {
        const cause = new Error("underlying");
        const e = new SettingsAckTimeoutError(1000, { cause });
        expect(e.timeoutMs).toBe(1000);
        expect(e.cause).toBe(cause);
    });
});

// ---------------------------------------------------------------------------
// utils.ts — assertNever, concat, concatAll across their branches.
// ---------------------------------------------------------------------------

describe("utils", () => {
    it("assertNever throws on an unreachable value", () => {
        expect(() => assertNever("unreachable" as never)).toThrow(/Unexpected value/);
    });

    it("concat joins two non-empty arrays", () => {
        const out = concat(new Uint8Array([1, 2]), new Uint8Array([3, 4]));
        expect(out).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("concat handles a leading empty array", () => {
        const out = concat(new Uint8Array(), new Uint8Array([5, 6]));
        expect(out).toEqual(new Uint8Array([5, 6]));
    });

    it("concat handles a trailing empty array", () => {
        const out = concat(new Uint8Array([5, 6]), new Uint8Array());
        expect(out).toEqual(new Uint8Array([5, 6]));
    });

    it("concat handles both empty arrays", () => {
        const out = concat(new Uint8Array(), new Uint8Array());
        expect(out).toEqual(new Uint8Array());
        expect(out.length).toBe(0);
    });

    it("concatAll joins many arrays", () => {
        const out = concatAll([new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])]);
        expect(out).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("concatAll returns an empty array for no parts", () => {
        const out = concatAll([]);
        expect(out).toEqual(new Uint8Array());
        expect(out.length).toBe(0);
    });

    it("concatAll handles a single part", () => {
        const out = concatAll([new Uint8Array([7, 8])]);
        expect(out).toEqual(new Uint8Array([7, 8]));
    });

    it("concatAll skips empty parts", () => {
        const out = concatAll([new Uint8Array(), new Uint8Array([9]), new Uint8Array()]);
        expect(out).toEqual(new Uint8Array([9]));
    });
});

// ---------------------------------------------------------------------------
// varint.ts — getVarintEncodedLength across every branch + boundary value.
// ---------------------------------------------------------------------------

describe("getVarintEncodedLength", () => {
    const twoTo6 = 1n << 6n; // 64
    const twoTo14 = 1n << 14n; // 16384
    const twoTo30 = 1n << 30n;

    it("throws RangeError on a negative value", () => {
        expect(() => getVarintEncodedLength(-1n)).toThrow(RangeError);
    });

    it("throws RangeValue on a value above VARINT_MAX", () => {
        expect(() => getVarintEncodedLength(VARINT_MAX + 1n)).toThrow(RangeError);
    });

    it("encodes 0 in one byte", () => {
        expect(getVarintEncodedLength(0n)).toBe(1);
    });

    it("one byte holds the top of the 1-byte range (2^6 - 1)", () => {
        expect(getVarintEncodedLength(twoTo6 - 1n)).toBe(1);
    });

    it("two bytes start at 2^6", () => {
        expect(getVarintEncodedLength(twoTo6)).toBe(2);
    });

    it("two bytes hold the top of the 2-byte range (2^14 - 1)", () => {
        expect(getVarintEncodedLength(twoTo14 - 1n)).toBe(2);
    });

    it("four bytes start at 2^14", () => {
        expect(getVarintEncodedLength(twoTo14)).toBe(4);
    });

    it("four bytes hold the top of the 4-byte range (2^30 - 1)", () => {
        expect(getVarintEncodedLength(twoTo30 - 1n)).toBe(4);
    });

    it("eight bytes start at 2^30", () => {
        expect(getVarintEncodedLength(twoTo30)).toBe(8);
    });

    it("eight bytes hold the maximum encodable value (2^62 - 1)", () => {
        expect(getVarintEncodedLength(VARINT_MAX)).toBe(8);
    });
});

// ---------------------------------------------------------------------------
// types.ts — the constant tables are runtime values; assert their contents.
// ---------------------------------------------------------------------------

describe("constants", () => {
    it("VARINT_MAX equals 2^62 - 1", () => {
        expect(VARINT_MAX).toBe((1n << 62n) - 1n);
    });

    it("Http3StreamType identifiers match RFC 9114 §6.2", () => {
        expect(Http3StreamType.CONTROL).toBe(0x0);
        expect(Http3StreamType.PUSH).toBe(0x1);
        expect(Http3StreamType.QPACK_ENCODER).toBe(0x2);
        expect(Http3StreamType.QPACK_DECODER).toBe(0x3);
    });

    it("Http3FrameType identifiers match RFC 9114 §7.2", () => {
        expect(Http3FrameType.DATA).toBe(0x0);
        expect(Http3FrameType.HEADERS).toBe(0x1);
        expect(Http3FrameType.CANCEL_PUSH).toBe(0x3);
        expect(Http3FrameType.SETTINGS).toBe(0x4);
        expect(Http3FrameType.PUSH_PROMISE).toBe(0x5);
        expect(Http3FrameType.GOAWAY).toBe(0x7);
        expect(Http3FrameType.MAX_PUSH_ID).toBe(0x0d);
    });

    it("Http3Settings identifiers match RFC 9114 §7.2.4", () => {
        expect(Http3Settings.QPACK_MAX_TABLE_CAPACITY).toBe(0x1);
        expect(Http3Settings.MAX_FIELD_SECTION_SIZE).toBe(0x6);
        expect(Http3Settings.QPACK_BLOCKED_STREAMS).toBe(0x7);
    });
});

// ---------------------------------------------------------------------------
// TODO stubs — covered by asserting their (only) existing behaviour: throwing.
// These confirm the placeholders are wired up without implementing them.
// QPACK (encodeHeaders/decodeHeaders/QpackEncoder/QpackDecoder) is implemented
// in src/qpack/ and covered by tests/qpack-coverage.test.ts, so it is excluded
// here.
// ---------------------------------------------------------------------------

describe("TODO stubs throw their placeholder error", () => {
    it("encodeVarint is unimplemented", () => {
        expect(() => encodeVarint(0n)).toThrow(/TODO/);
    });

    it("decodeVarint is unimplemented", () => {
        expect(() => decodeVarint(new Uint8Array([0]))).toThrow(/TODO/);
    });

    it("serializeFrame is unimplemented", () => {
        const frame: Http3Frame = { type: Http3FrameType.DATA, payload: new Uint8Array() };
        expect(() => serializeFrame(frame)).toThrow(/TODO/);
    });

    it("readFrame is unimplemented", async () => {
        await expect(readFrame(async () => new Uint8Array([0x00]))).rejects.toThrow(/TODO/);
    });

    it("createStreamManager is unimplemented", () => {
        expect(() => createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} })).toThrow(
            /TODO/,
        );
    });

    it("Http3ConnectionImpl constructor is unimplemented", () => {
        const options = { quic: {} as unknown as QuicConnection };
        expect(() => new Http3ConnectionImpl(options)).toThrow(/TODO/);
    });

    it("Http3ConnectionImpl instance methods are unimplemented", async () => {
        // The constructor throws, so reach the methods via the prototype with a
        // stub `this`. None of them touch `this`, so a bare prototype object
        // suffices.
        const stub = Object.create(Http3ConnectionImpl.prototype);
        await expect(stub.request({} as unknown as Http3Request)).rejects.toThrow(/TODO/);
        await expect(stub.goaway(0n)).rejects.toThrow(/TODO/);
        await expect(stub.close()).rejects.toThrow(/TODO/);
    });

    it("connectHttp3 is unimplemented", async () => {
        await expect(connectHttp3({ quic: {} as unknown as QuicConnection })).rejects.toThrow(/TODO/);
    });
});

// ---------------------------------------------------------------------------
// Genuinely unimplemented features — placeholders for the PLAN.md checklist.
// These are NOT built here; they are listed in the final report.
// ---------------------------------------------------------------------------

describe("unimplemented features (PLAN.md checklist)", () => {
    it.todo("Step 1 — varint encode/decode wire round-trip");
    it.todo("Step 2 — every frame type parses and serializes");
    it.todo("Step 5 — stream manager dispatches by stream id");
    it.todo("Step 6 — SETTINGS handshake completes or times out");
    it.todo("Step 7 — concurrent request multiplexing");
    it.todo("Step 8 — GOAWAY sent/received");
    it.todo("Step 9 — server push handling");
    it.todo("Step 10 — GREASE / reserved frames ignored");
    it.todo("Step 11 — end-to-end over fake QUIC");
});
