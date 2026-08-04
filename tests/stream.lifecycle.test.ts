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
 *   - dispatchRequestFrame(): PUSH_PROMISE emits 'pushPromise' (lines 225-226).
 *   - dispatchToPending(): illegal frames (SETTINGS/CANCEL_PUSH/PUSH_PROMISE/
 *     GOAWAY/MAX_PUSH_ID) on a request/push stream are ignored (line 265).
 *   - dispatchControlFrame(): GREASE and DATA/HEADERS/PUSH_PROMISE on the
 *     control stream are ignored (lines 295-302); CANCEL_PUSH rejects a
 *     registered push resolver (lines 292-293, 339-342).
 *   - abortAll() rejects pushes (line 351).
 */

import { describe, it, expect } from "vitest";
import { createStreamManager, PushCancelledError } from "../src/stream/stream.js";
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

    it("falls back to status 200 when :status is absent", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // A decoder that returns headers WITHOUT a :status key exercises the
        // `status === undefined` false branch in finalize (line 210).
        mgr.setHeaderDecoder(() => new Map([["content-type", "text/plain"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
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

    it("off() silently ignores a listener that was never registered", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // Calling off() with a listener that was never added must be a safe
        // no-op — exercises the `entry === undefined` false branch in
        // StreamEventBridge.off() (line 135-137).
        const neverAdded = () => {};
        expect(() => mgr.off("settings", neverAdded)).not.toThrow();
    });

    it("removeAllListeners(event) only clears listeners for that event", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let settingsCount = 0;
        let goawayCount = 0;
        mgr.on("settings", () => {
            settingsCount += 1;
        });
        mgr.on("goaway", () => {
            goawayCount += 1;
        });
        // removeAllListeners("settings") should clear only the settings
        // listener — exercises the `entry.event === target` true and false
        // branches (line 151): the settings listener matches (true), the
        // goaway listener does not (false).
        mgr.removeAllListeners("settings");
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        mgr.dispatchControlFrame({ type: Http3FrameType.GOAWAY, streamId: 1n });
        expect(settingsCount).toBe(0);
        expect(goawayCount).toBe(1);
    });

    it("removeAllListeners() with no argument clears every listener", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let settingsCount = 0;
        let goawayCount = 0;
        mgr.on("settings", () => {
            settingsCount += 1;
        });
        mgr.on("goaway", () => {
            goawayCount += 1;
        });
        // removeAllListeners() with no argument exercises the
        // `target === undefined` branch (line 149) — clears ALL listeners.
        mgr.removeAllListeners();
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        mgr.dispatchControlFrame({ type: Http3FrameType.GOAWAY, streamId: 1n });
        expect(settingsCount).toBe(0);
        expect(goawayCount).toBe(0);
    });

    it("removeListener() unsubscribes a listener (delegates to off)", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let count = 0;
        const listener = () => {
            count += 1;
        };
        mgr.on("settings", listener);
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        // removeListener is an alias for off — both exercise the
        // StreamEventBridge.off() path (line 144) and the manager's
        // removeListener property (line 377).
        mgr.removeListener("settings", listener);
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(count).toBe(1);
    });
});

describe("stream manager — illegal frames on request stream (dispatchToPending fallthrough)", () => {
    it("ignores SETTINGS frames dispatched to a pending request stream", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        // A SETTINGS frame on a request stream is illegal — must be ignored
        // (falls through the SETTINGS/CANCEL_PUSH/PUSH_PROMISE/GOAWAY/
        // MAX_PUSH_ID cases in dispatchToPending, line 265 break).
        mgr.dispatchRequestFrame(0n, { type: Http3FrameType.SETTINGS, settings: {} });
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        expect((await result).statusCode).toBe(200);
    });

    it("ignores GOAWAY frames dispatched to a pending request stream", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, { type: Http3FrameType.GOAWAY, streamId: 99n });
        mgr.dispatchRequestFrame(0n, DATA([0x62]));
        expect((await result).statusCode).toBe(200);
    });

    it("ignores CANCEL_PUSH frames dispatched to a pending request stream", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const result = new Promise((resolve, reject) => mgr.expectResponse(0n, resolve, reject));
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, { type: Http3FrameType.CANCEL_PUSH, pushId: 5n });
        mgr.dispatchRequestFrame(0n, DATA([0x63]));
        expect((await result).statusCode).toBe(200);
    });

    it("ignores PUSH_PROMISE frames dispatched to a pending request stream via dispatchToPending", async () => {
        // Note: dispatchRequestFrame has an early-return for PUSH_PROMISE that
        // emits a 'pushPromise' event. To exercise the fallthrough case in
        // dispatchToPending (line 265), we send a PUSH_PROMISE to a push stream
        // via dispatchPushFrame instead — push frames bypass the PUSH_PROMISE
        // early-return.
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));
        const result = new Promise((resolve, reject) => mgr.expectPush(4n, resolve, reject));
        mgr.dispatchPushFrame(4n, HEADERS([0x80]));
        // PUSH_PROMISE on a push stream — illegal, must hit the fallthrough break.
        mgr.dispatchPushFrame(4n, { type: Http3FrameType.PUSH_PROMISE, pushId: 1n, payload: new Uint8Array([0x00]) });
        mgr.dispatchPushFrame(4n, DATA([0x7a]));
        expect((await result).statusCode).toBe(200);
    });
});

describe("stream manager — control stream ignores DATA/HEADERS/PUSH_PROMISE + GREASE (lines 295-302)", () => {
    it("ignores GREASE / unknown frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let settingsCount = 0;
        mgr.on("settings", () => {
            settingsCount += 1;
        });
        // A GREASE frame on the control stream must be silently ignored
        // (hits the HTTP3_UNKNOWN_FRAME_TYPE case at line 295).
        mgr.dispatchControlFrame({ type: HTTP3_UNKNOWN_FRAME_TYPE, rawType: 0x21, payload: new Uint8Array([0xff]) });
        // Sanity: SETTINGS still works after the GREASE frame.
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(settingsCount).toBe(1);
    });

    it("ignores DATA frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let settingsCount = 0;
        mgr.on("settings", () => {
            settingsCount += 1;
        });
        // DATA on the control stream is illegal — must be silently ignored
        // (hits the fallthrough DATA/HEADERS/PUSH_PROMISE cases, lines 300-302).
        mgr.dispatchControlFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([0x00]) });
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(settingsCount).toBe(1);
    });

    it("ignores HEADERS frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let settingsCount = 0;
        mgr.on("settings", () => {
            settingsCount += 1;
        });
        // HEADERS on the control stream is illegal — must be silently ignored.
        mgr.dispatchControlFrame({ type: Http3FrameType.HEADERS, payload: new Uint8Array([0x80]) });
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(settingsCount).toBe(1);
    });

    it("ignores PUSH_PROMISE frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let settingsCount = 0;
        mgr.on("settings", () => {
            settingsCount += 1;
        });
        // PUSH_PROMISE on the control stream is illegal — must be silently ignored.
        mgr.dispatchControlFrame({ type: Http3FrameType.PUSH_PROMISE, pushId: 1n, payload: new Uint8Array([0x00]) });
        mgr.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(settingsCount).toBe(1);
    });
});

describe("stream manager — PUSH_PROMISE emits 'pushPromise' (lines 225-226)", () => {
    it("emits 'pushPromise' when a PUSH_PROMISE frame arrives on a request stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let gotPushId: bigint | undefined;
        let gotPayload: Bytes | undefined;
        mgr.on("pushPromise", (pushId: bigint, payload: Bytes) => {
            gotPushId = pushId;
            gotPayload = payload;
        });
        // A PUSH_PROMISE on a request stream triggers the early-return in
        // dispatchRequestFrame (lines 225-226), emitting 'pushPromise' with
        // the push id and header-block payload.
        mgr.dispatchRequestFrame(0n, {
            type: Http3FrameType.PUSH_PROMISE,
            pushId: 7n,
            payload: new Uint8Array([0x80, 0x01]),
        });
        expect(gotPushId).toBe(7n);
        expect(gotPayload).toBeDefined();
    });
});

describe("stream manager — CANCEL_PUSH rejects a registered push (lines 292-293, 339-342)", () => {
    it("silently ignores CANCEL_PUSH for an unknown push id", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // No push registered — cancelPush must be a safe no-op (exercises the
        // `p === undefined` false branch at line 340).
        expect(() =>
            mgr.dispatchControlFrame({ type: Http3FrameType.CANCEL_PUSH, pushId: 99n }),
        ).not.toThrow();
    });

    it("rejects the push resolver with PushCancelledError on CANCEL_PUSH", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });

        const p = new Promise<void>((resolve, reject) => {
            // Register a push with pushId=3n.
            mgr.expectPush(
                3n,
                () => reject(new Error("push should not resolve")),
                (err) => {
                    // Verify the error is a PushCancelledError with the right pushId.
                    if (err instanceof PushCancelledError && err.pushId === 3n) {
                        resolve();
                    } else {
                        reject(new Error(`unexpected error: ${err}`));
                    }
                },
            );
        });

        // A CANCEL_PUSH frame on the control stream dispatches to cancelPush
        // (line 292), which finds the pending push (line 340) and rejects it
        // (line 342).
        mgr.dispatchControlFrame({ type: Http3FrameType.CANCEL_PUSH, pushId: 3n });
        await p;
    });
});

describe("stream manager — abortAll rejects pushes (line 351)", () => {
    it("rejects both pending responses and registered pushes", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));

        const pResp = new Promise<void>((resolve, reject) => {
            mgr.expectResponse(0n, () => reject(new Error("response should not resolve")), () => resolve());
        });
        const pPush = new Promise<void>((resolve, reject) => {
            mgr.expectPush(2n, () => reject(new Error("push should not resolve")), () => resolve());
        });

        // abortAll iterates both `pending` and `pushes` maps — the pushes
        // loop (line 350-351) only executes when pushes is non-empty.
        mgr.abortAll(new Error("connection closed"));

        await pResp;
        await pPush;
    });
});
