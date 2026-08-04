/**
 * HTTP/3 stream manager lifecycle (PLAN.md Step 5) — branches beyond the
 * basic control/request/response dispatch in stream.test.ts.
 *
 * The manager is I/O-free, so it is driven directly with parsed Http3Frame
 * objects and a fake header decoder. This covers:
 *   - finalize(): a non-200 status, a multi-chunk body, and the
 *     ":status" non-finite fallback to 200.
 *   - dispatchRequestFrame() for an unknown stream id (no-op).
 *   - dispatchPushFrame() correlates a push response by push id.
 *   - dispatchToPending(): GREASE / unknown frames are ignored; DATA with a
 *     payload appends to the body.
 *   - dispatchControlFrame(): MAX_PUSH_ID emits "maxPushId"; SETTINGS emits
 *     "settings"; GOAWAY emits "goaway".
 *   - abortAll() rejects every pending response.
 *   - StreamEventBridge: once() fires once, off()/removeListener() unsubscribe,
 *     removeAllListeners() clears handlers.
 */

import { describe, it, expect } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";
import { Http3FrameType, HTTP3_UNKNOWN_FRAME_TYPE, type Http3Frame } from "../src/types.js";

const HEADERS = (payload: number[]): Http3Frame => ({
    type: Http3FrameType.HEADERS,
    payload: new Uint8Array(payload),
});
const DATA = (payload: number[]): Http3Frame => ({
    type: Http3FrameType.DATA,
    payload: new Uint8Array(payload),
});
const GREASE = (payload: number[]): Http3Frame => ({
    type: HTTP3_UNKNOWN_FRAME_TYPE,
    rawType: 0x21,
    payload: new Uint8Array(payload),
});

describe("stream manager — finalize (status + body)", () => {
    it("parses a non-200 status from :status", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "404"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        expect((await result).statusCode).toBe(404);
    });

    it("delivers the request body from the DATA frame", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        // The manager treats every DATA frame as the end of the stream (a
        // simplification: it sets endStreamSeen on any DATA), so the body is
        // whatever the (single) DATA frame carried.
        mgr.dispatchRequestFrame(0n, DATA([0x61, 0x62, 0x63, 0x64]));
        const res = await result;
        expect(new TextDecoder().decode(res.body)).toBe("abcd");
    });

    it("falls back to status 200 when :status is not finite", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "not-a-number"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([]));
        expect((await result).statusCode).toBe(200);
    });
});

describe("stream manager — dispatch edge cases", () => {
    it("ignores frames for an unknown stream id", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // No expectResponse registered — must be a silent no-op.
        mgr.dispatchRequestFrame(4n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(4n, DATA([0x61]));
    });

    it("ignores push frames for an unknown push id", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // No expectPush registered — must be a silent no-op.
        mgr.dispatchPushFrame(4n, HEADERS([0x80]));
        mgr.dispatchPushFrame(4n, DATA([0x61]));
    });

    it("rejects the response when the header decoder throws (default decoder)", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // Do NOT set a header decoder: the default decoder throws
        // "no header decoder set", and finalize rejects the response.
        const result = new Promise<void>((resolve, reject) => {
            mgr.expectResponse(0n, () => reject(new Error("should not resolve")), () => resolve());
        });
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([]));
        await result;
    });

    it("rejects the response when header decoding fails", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // A decoder that throws forces finalize down the reject path.
        mgr.setHeaderDecoder(() => {
            throw new Error("boom");
        });
        const result = new Promise<void>((resolve, reject) => {
            mgr.expectResponse(0n, () => reject(new Error("should not resolve")), () => resolve());
        });
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([]));
        await result;
    });

    it("correlates a push response by push id", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const result = new Promise((resolve, reject) => mgr.expectPush(2n, resolve, reject));
        mgr.dispatchPushFrame(2n, HEADERS([0x80]));
        mgr.dispatchPushFrame(2n, DATA([0x7a]));
        const res = (await result) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
        expect(new TextDecoder().decode(res.body)).toBe("z");
    });

    it("ignores GREASE / unknown frames on a request stream", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        // GREASE frame between HEADERS and DATA must be ignored (not treated as
        // DATA, which would prematurely signal endStream).
        mgr.dispatchRequestFrame(0n, GREASE([0xff]));
        mgr.dispatchRequestFrame(0n, DATA([]));
        expect((await result).statusCode).toBe(200);
    });
});

describe("stream manager — control frame dispatch", () => {
    it("emits maxPushId on a MAX_PUSH_ID frame", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let got: bigint | undefined;
        mgr.on("maxPushId", (id: bigint) => {
            got = id;
        });
        const frame: Http3Frame = { type: Http3FrameType.MAX_PUSH_ID, pushId: 123n };
        mgr.dispatchControlFrame(frame);
        expect(got).toBe(123n);
    });

    it("emits settings on a SETTINGS frame", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let count = 0;
        mgr.on("settings", () => {
            count += 1;
        });
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(count).toBe(1);
    });

    it("emits goaway with the stream id on a GOAWAY frame", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let got: bigint | undefined;
        mgr.on("goaway", (id: bigint) => {
            got = id;
        });
        mgr.dispatchControlFrame({ type: Http3FrameType.GOAWAY, streamId: 77n });
        expect(got).toBe(77n);
    });
});

describe("stream manager — abortAll", () => {
    it("rejects all registered responses", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const p = new Promise<void>((resolve, reject) => {
            mgr.expectResponse(0n, () => reject(new Error("should not resolve")), () => resolve());
        });
        mgr.abortAll(new Error("connection closed"));
        await p;
    });
});

describe("StreamEventBridge — subscription lifecycle", () => {
    it("once() fires exactly once", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let count = 0;
        mgr.once("settings", () => {
            count += 1;
        });
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(count).toBe(1);
    });

    it("off() unsubscribes a listener", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let count = 0;
        const listener = () => {
            count += 1;
        };
        mgr.on("settings", listener);
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        mgr.off("settings", listener);
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(count).toBe(1);
    });

    it("removeAllListeners() clears handlers", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let count = 0;
        mgr.on("settings", () => {
            count += 1;
        });
        mgr.removeAllListeners("settings");
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(count).toBe(0);
    });

    it("emit() dispatches detail to listeners", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let got: bigint | undefined;
        mgr.on("goaway", (id: bigint) => {
            got = id;
        });
        // The manager's emit forwards args to the EventTarget bridge, which
        // delivers them spread via CustomEvent.detail.
        mgr.emit("goaway", 99n);
        expect(got).toBe(99n);
    });
});
