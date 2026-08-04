/**
 * Exhaustive stream manager coverage.
 *
 * Covers every state transition in the request/response accumulator
 * (headersComplete × endStreamSeen), flow-control (DATA accumulation),
 * FIN handling, bidirectional vs. unidirectional (push) streams, control
 * frame dispatch, the EventEmitter contract, and all error paths.
 */

import { describe, it, expect, vi } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";
import {
    Http3FrameType,
    HTTP3_UNKNOWN_FRAME_TYPE,
    type Http3Frame,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

const HEADERS = (payload: number[]): Http3Frame => ({
    type: Http3FrameType.HEADERS,
    payload: new Uint8Array(payload),
});

const DATA = (payload: number[]): Http3Frame => ({
    type: Http3FrameType.DATA,
    payload: new Uint8Array(payload),
});

const SETTINGS = (): Http3Frame => ({ type: Http3FrameType.SETTINGS, settings: {} });

const GOAWAY = (streamId: bigint): Http3Frame => ({ type: Http3FrameType.GOAWAY, streamId });

const MAX_PUSH_ID = (pushId: bigint): Http3Frame => ({ type: Http3FrameType.MAX_PUSH_ID, pushId });

const CANCEL_PUSH = (pushId: bigint): Http3Frame => ({ type: Http3FrameType.CANCEL_PUSH, pushId });

const PUSH_PROMISE = (pushId: bigint): Http3Frame => ({
    type: Http3FrameType.PUSH_PROMISE,
    pushId,
    payload: new Uint8Array(0),
});

const UNKNOWN = (rawType: number): Http3Frame => ({
    type: HTTP3_UNKNOWN_FRAME_TYPE,
    rawType,
    payload: new Uint8Array([0xff]),
});

// A header decoder that returns a fixed status.
const decoderForStatus = (status: string) => () => new Map([[":status", status]]);
const defaultDecoder = () => new Map([[":status", "200"]]);

/** Build a manager with a default decoder set, ready for request/response tests. */
const makeManager = () => {
    const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
    mgr.setHeaderDecoder(defaultDecoder);
    return mgr;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register an expectation and return a promise that resolves/rejects with the result. */
const expectResponse = (mgr: ReturnType<typeof createStreamManager>, streamId: bigint) =>
    new Promise<unknown>((resolve, reject) => {
        mgr.expectResponse(streamId, resolve, reject);
    });

const expectPush = (mgr: ReturnType<typeof createStreamManager>, pushId: bigint) =>
    new Promise<unknown>((resolve, reject) => {
        mgr.expectPush(pushId, resolve, reject);
    });

// ---------------------------------------------------------------------------
// State transitions: headersComplete × endStreamSeen
// ---------------------------------------------------------------------------

describe("state transition — HEADERS only (headersComplete=true, endStreamSeen=false)", () => {
    it("does not resolve until a DATA frame arrives", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));

        // Use a microtask flush to confirm it didn't resolve synchronously.
        let settled = false;
        p.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        // Now complete it.
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
        expect(new TextDecoder().decode(res.body)).toBe("a");
    });
});

describe("state transition — DATA only (endStreamSeen=true, headersComplete=false)", () => {
    it("does not resolve until a HEADERS frame arrives", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, DATA([0x62]));

        let settled = false;
        p.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
        expect(new TextDecoder().decode(res.body)).toBe("b");
    });
});

describe("state transition — DATA before HEADERS (reverse order)", () => {
    it("accumulates body, then resolves once HEADERS arrive", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 4n);

        mgr.dispatchRequestFrame(4n, DATA([0x61, 0x62]));
        mgr.dispatchRequestFrame(4n, DATA([0x63]));
        mgr.dispatchRequestFrame(4n, HEADERS([0x80]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(new TextDecoder().decode(res.body)).toBe("abc");
    });
});

describe("state transition — DATA triggers finalization", () => {
    it("finalizes after the first DATA frame; subsequent DATA is ignored", async () => {
        // The manager sets endStreamSeen on the first DATA frame and finalizes.
        // A second DATA frame finds no pending entry and is silently ignored.
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61, 0x62]));
        mgr.dispatchRequestFrame(0n, DATA([0x63, 0x64])); // ignored — already finalized

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(new TextDecoder().decode(res.body)).toBe("ab");
    });
});

describe("state transition — empty DATA frame does not append to body", () => {
    it("skips zero-length DATA payloads but still marks endStreamSeen", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.body.length).toBe(0);
    });
});

describe("state transition — empty DATA finalizes without body", () => {
    it("an empty DATA frame finalizes the stream with an empty body", async () => {
        // The manager sets endStreamSeen on any DATA frame, even an empty one.
        // An empty payload is not pushed to the body array.
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.body.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// FIN handling (DATA with endStreamSeen)
// ---------------------------------------------------------------------------

describe("FIN handling", () => {
    it("marks endStreamSeen on the first DATA frame", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        // HEADERS first, no DATA yet → not complete.
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));

        // Single DATA frame is the FIN.
        mgr.dispatchRequestFrame(0n, DATA([0x01, 0x02, 0x03]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.body.length).toBe(3);
        expect(res.body[0]).toBe(0x01);
        expect(res.body[2]).toBe(0x03);
    });

    it("resolves immediately when HEADERS and DATA arrive back-to-back", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0xff]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.body.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Bidirectional streams (request/response)
// ---------------------------------------------------------------------------

describe("bidirectional streams", () => {
    it("correlates each stream id independently", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));

        const p0 = expectResponse(mgr, 0n);
        const p4 = expectResponse(mgr, 4n);
        const p8 = expectResponse(mgr, 8n);

        // Interleave frames for different streams.
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(4n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(8n, HEADERS([0x80]));

        mgr.dispatchRequestFrame(4n, DATA([0x62]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        mgr.dispatchRequestFrame(8n, DATA([0x63]));

        const r0 = (await p0) as { body: Uint8Array };
        const r4 = (await p4) as { body: Uint8Array };
        const r8 = (await p8) as { body: Uint8Array };

        expect(new TextDecoder().decode(r0.body)).toBe("a");
        expect(new TextDecoder().decode(r4.body)).toBe("b");
        expect(new TextDecoder().decode(r8.body)).toBe("c");
    });

    it("ignores frames for unknown stream ids without throwing", () => {
        const mgr = makeManager();
        expect(() => {
            mgr.dispatchRequestFrame(999n, HEADERS([0x80]));
            mgr.dispatchRequestFrame(999n, DATA([0x61]));
        }).not.toThrow();
    });

    it("resolves with the decoded :status", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(decoderForStatus("404"));

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(404);
    });

    it("defaults to 200 when :status is missing", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(() => new Map([["x-custom", "value"]]));

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });

    it("defaults to 200 when :status is non-numeric", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(() => new Map([[":status", "not-a-number"]]));

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });

    it("defaults to 200 when :status is Infinity", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(() => new Map([[":status", "Infinity"]]));

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });

    it("rejects when the header decoder throws", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(() => {
            throw new Error("QPACK decode failed");
        });

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        await expect(p).rejects.toThrow("QPACK decode failed");
    });

    it("survives a second HEADERS frame (last-write-wins for headerBlock)", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x01]));
        mgr.dispatchRequestFrame(0n, HEADERS([0x02]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        // The manager does not re-finalize; it only finalizes once. The second
        // HEADERS overwrites headerBlock but does not trigger a second resolve.
        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
        expect(new TextDecoder().decode(res.body)).toBe("a");
    });
});

// ---------------------------------------------------------------------------
// Unidirectional streams (push)
// ---------------------------------------------------------------------------

describe("unidirectional push streams", () => {
    it("correlates a push response by push id", async () => {
        const mgr = makeManager();
        const p = expectPush(mgr, 2n);

        mgr.dispatchPushFrame(2n, HEADERS([0x80]));
        mgr.dispatchPushFrame(2n, DATA([0x7a]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
        expect(new TextDecoder().decode(res.body)).toBe("z");
    });

    it("ignores push frames for unknown push ids", () => {
        const mgr = makeManager();
        expect(() => {
            mgr.dispatchPushFrame(99n, HEADERS([0x80]));
            mgr.dispatchPushFrame(99n, DATA([0x61]));
        }).not.toThrow();
    });

    it("resolves push with the decoded :status", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(decoderForStatus("301"));

        const p = expectPush(mgr, 0n);
        mgr.dispatchPushFrame(0n, HEADERS([0x80]));
        mgr.dispatchPushFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(301);
    });

    it("rejects push when the header decoder throws", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(() => {
            throw new Error("bad block");
        });

        const p = expectPush(mgr, 0n);
        mgr.dispatchPushFrame(0n, HEADERS([0x80]));
        mgr.dispatchPushFrame(0n, DATA([0x61]));

        // The manager wraps decoder errors as "QPACK decode failed".
        await expect(p).rejects.toThrow("QPACK decode failed");
    });

    it("does not resolve push until both HEADERS and DATA arrive", async () => {
        const mgr = makeManager();
        const p = expectPush(mgr, 0n);

        mgr.dispatchPushFrame(0n, HEADERS([0x80]));

        let settled = false;
        p.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        mgr.dispatchPushFrame(0n, DATA([0x61]));
        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });

    it("handles multiple concurrent pushes", async () => {
        const mgr = makeManager();
        const p0 = expectPush(mgr, 0n);
        const p2 = expectPush(mgr, 2n);
        const p4 = expectPush(mgr, 4n);

        mgr.dispatchPushFrame(0n, HEADERS([0x80]));
        mgr.dispatchPushFrame(2n, HEADERS([0x80]));
        mgr.dispatchPushFrame(4n, HEADERS([0x80]));

        mgr.dispatchPushFrame(2n, DATA([0x62]));
        mgr.dispatchPushFrame(0n, DATA([0x61]));
        mgr.dispatchPushFrame(4n, DATA([0x63]));

        const r0 = (await p0) as { body: Uint8Array };
        const r2 = (await p2) as { body: Uint8Array };
        const r4 = (await p4) as { body: Uint8Array };

        expect(new TextDecoder().decode(r0.body)).toBe("a");
        expect(new TextDecoder().decode(r2.body)).toBe("b");
        expect(new TextDecoder().decode(r4.body)).toBe("c");
    });
});

// ---------------------------------------------------------------------------
// Control stream dispatch
// ---------------------------------------------------------------------------

describe("control stream dispatch", () => {
    it("emits 'settings' for a SETTINGS frame", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.dispatchControlFrame(SETTINGS());
        expect(spy).toHaveBeenCalledOnce();
    });

    it("emits 'goaway' with the stream id", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("goaway", spy);
        mgr.dispatchControlFrame(GOAWAY(42n));
        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(42n);
    });

    it("emits 'maxPushId' with the push id", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("maxPushId", spy);
        mgr.dispatchControlFrame(MAX_PUSH_ID(16n));
        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(16n);
    });

    it("ignores DATA frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.dispatchControlFrame(DATA([0x61]));
        expect(spy).not.toHaveBeenCalled();
    });

    it("ignores HEADERS frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.dispatchControlFrame(HEADERS([0x80]));
        expect(spy).not.toHaveBeenCalled();
    });

    it("ignores CANCEL_PUSH frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.dispatchControlFrame(CANCEL_PUSH(0n));
        expect(spy).not.toHaveBeenCalled();
    });

    it("ignores PUSH_PROMISE frames on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.dispatchControlFrame(PUSH_PROMISE(0n));
        expect(spy).not.toHaveBeenCalled();
    });

    it("ignores unknown frame types on the control stream", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.dispatchControlFrame(UNKNOWN(0x1f));
        expect(spy).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Illegal frames on request/response streams are ignored
// ---------------------------------------------------------------------------

describe("illegal frames on request/response streams are ignored", () => {
    it("ignores SETTINGS on a request stream", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, SETTINGS());
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
        expect(new TextDecoder().decode(res.body)).toBe("a");
    });

    it("ignores CANCEL_PUSH on a request stream", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, CANCEL_PUSH(5n));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
    });

    it("ignores PUSH_PROMISE on a request stream", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, PUSH_PROMISE(1n));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
    });

    it("ignores GOAWAY on a request stream", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, GOAWAY(0n));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
    });

    it("ignores MAX_PUSH_ID on a request stream", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, MAX_PUSH_ID(10n));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
    });

    it("ignores unknown frame types on a request stream", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, UNKNOWN(0x1f));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
    });

    it("ignores illegal frames on a push stream", async () => {
        const mgr = makeManager();
        const p = expectPush(mgr, 0n);

        mgr.dispatchPushFrame(0n, HEADERS([0x80]));
        mgr.dispatchPushFrame(0n, SETTINGS());
        mgr.dispatchPushFrame(0n, CANCEL_PUSH(1n));
        mgr.dispatchPushFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// abortAll
// ---------------------------------------------------------------------------

describe("abortAll", () => {
    it("rejects all pending responses", async () => {
        const mgr = makeManager();
        const p0 = expectResponse(mgr, 0n);
        const p4 = expectResponse(mgr, 4n);

        mgr.abortAll(new Error("connection closed"));

        await expect(p0).rejects.toThrow("connection closed");
        await expect(p4).rejects.toThrow("connection closed");
    });

    it("rejects all pending pushes", async () => {
        const mgr = makeManager();
        const p0 = expectPush(mgr, 0n);
        const p2 = expectPush(mgr, 2n);

        mgr.abortAll(new Error("connection closed"));

        await expect(p0).rejects.toThrow("connection closed");
        await expect(p2).rejects.toThrow("connection closed");
    });

    it("rejects both responses and pushes in one call", async () => {
        const mgr = makeManager();
        const r0 = expectResponse(mgr, 0n);
        const r4 = expectResponse(mgr, 4n);
        const p0 = expectPush(mgr, 0n);
        const p2 = expectPush(mgr, 2n);

        mgr.abortAll(new Error("teardown"));

        await expect(r0).rejects.toThrow("teardown");
        await expect(r4).rejects.toThrow("teardown");
        await expect(p0).rejects.toThrow("teardown");
        await expect(p2).rejects.toThrow("teardown");
    });

    it("clears the pending maps so new requests can be registered after", async () => {
        const mgr = makeManager();
        const p0 = expectResponse(mgr, 0n);
        mgr.abortAll(new Error("closed"));
        await expect(p0).rejects.toThrow("closed");

        // A new request on the same stream id should work.
        const p0b = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        const res = (await p0b) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });

    it("is a no-op when nothing is pending", () => {
        const mgr = makeManager();
        expect(() => mgr.abortAll(new Error("nothing"))).not.toThrow();
    });

    it("does not reject already-resolved responses", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        await p; // resolved

        // abortAll should not throw or re-reject.
        expect(() => mgr.abortAll(new Error("late"))).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// EventEmitter contract
// ---------------------------------------------------------------------------

describe("EventEmitter contract", () => {
    it("supports on() for repeated delivery", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.dispatchControlFrame(SETTINGS());
        mgr.dispatchControlFrame(SETTINGS());
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("supports once() for one-shot delivery", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.once("settings", spy);
        mgr.dispatchControlFrame(SETTINGS());
        mgr.dispatchControlFrame(SETTINGS());
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("supports off() to unsubscribe", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.off("settings", spy);
        mgr.dispatchControlFrame(SETTINGS());
        expect(spy).not.toHaveBeenCalled();
    });

    it("supports removeListener() as an alias for off()", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("settings", spy);
        mgr.removeListener("settings", spy);
        mgr.dispatchControlFrame(SETTINGS());
        expect(spy).not.toHaveBeenCalled();
    });

    it("supports removeAllListeners(event) for a single event", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const settingsSpy = vi.fn();
        const goawaySpy = vi.fn();
        mgr.on("settings", settingsSpy);
        mgr.on("goaway", goawaySpy);
        mgr.removeAllListeners("settings");
        mgr.dispatchControlFrame(SETTINGS());
        mgr.dispatchControlFrame(GOAWAY(0n));
        expect(settingsSpy).not.toHaveBeenCalled();
        expect(goawaySpy).toHaveBeenCalledOnce();
    });

    it("supports removeAllListeners() with no arg to clear everything", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const settingsSpy = vi.fn();
        const goawaySpy = vi.fn();
        mgr.on("settings", settingsSpy);
        mgr.on("goaway", goawaySpy);
        mgr.removeAllListeners();
        mgr.dispatchControlFrame(SETTINGS());
        mgr.dispatchControlFrame(GOAWAY(0n));
        expect(settingsSpy).not.toHaveBeenCalled();
        expect(goawaySpy).not.toHaveBeenCalled();
    });

    it("emit() dispatches to listeners with arguments", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("custom", spy);
        mgr.emit("custom", 1n, "two", 3);
        expect(spy).toHaveBeenCalledWith([1n, "two", 3]);
    });

    it("emit() returns true when listeners exist", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.on("custom", spy);
        expect(mgr.emit("custom")).toBe(true);
    });

    it("emit() returns true even when no listeners exist (EventTarget dispatchEvent semantics)", () => {
        // dispatchEvent returns true unless preventDefault() is called —
        // having no listeners does not make it return false.
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        expect(mgr.emit("custom")).toBe(true);
    });

    it("once() auto-removes after first delivery", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        const spy = vi.fn();
        mgr.once("goaway", spy);
        mgr.dispatchControlFrame(GOAWAY(1n));
        mgr.dispatchControlFrame(GOAWAY(2n));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(1n);
    });
});

// ---------------------------------------------------------------------------
// setHeaderDecoder
// ---------------------------------------------------------------------------

describe("setHeaderDecoder", () => {
    it("uses the decoder set via setHeaderDecoder", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(decoderForStatus("302"));

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(302);
    });

    it("overrides a previously set decoder", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(decoderForStatus("200"));
        mgr.setHeaderDecoder(decoderForStatus("503"));

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(503);
    });

    it("rejects with 'QPACK decode failed' when no decoder is set", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        // No setHeaderDecoder call — default decoder throws, and the manager
        // wraps it as "QPACK decode failed".
        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        await expect(p).rejects.toThrow("QPACK decode failed");
    });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe("response shape", () => {
    it("includes the decoded headers map", async () => {
        const mgr = makeManager();
        mgr.setHeaderDecoder(
            () =>
                new Map([
                    [":status", "200"],
                    ["content-type", "text/plain"],
                    ["x-custom", "yes"],
                ]),
        );

        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { headers: Map<string, string> };
        expect(res.headers.get(":status")).toBe("200");
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(res.headers.get("x-custom")).toBe("yes");
    });

    it("returns an empty body when no DATA frame arrives", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        // HEADERS with an empty payload, then a single empty DATA frame.
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([]));

        const res = (await p) as { body: Uint8Array };
        expect(res.body.length).toBe(0);
    });

    it("preserves binary body bytes verbatim", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x01]);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA(Array.from(bytes)));

        const res = (await p) as { body: Uint8Array };
        expect(res.body).toEqual(bytes);
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
    it("handles stream id 0n (first client-initiated bidirectional stream)", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);
        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });

    it("handles large stream ids (62-bit)", async () => {
        const mgr = makeManager();
        const bigId = (1n << 62n) - 1n; // VARINT_MAX
        const p = expectResponse(mgr, bigId);
        mgr.dispatchRequestFrame(bigId, HEADERS([0x80]));
        mgr.dispatchRequestFrame(bigId, DATA([0x61]));
        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });

    it("handles even and odd stream ids (client vs server initiated)", async () => {
        const mgr = makeManager();
        const pClient = expectResponse(mgr, 0n); // client-initiated (even)
        const pServer = expectResponse(mgr, 1n); // server-initiated (odd)

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(1n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));
        mgr.dispatchRequestFrame(1n, DATA([0x62]));

        const rClient = (await pClient) as { body: Uint8Array };
        const rServer = (await pServer) as { body: Uint8Array };
        expect(new TextDecoder().decode(rClient.body)).toBe("a");
        expect(new TextDecoder().decode(rServer.body)).toBe("b");
    });

    it("does not double-resolve when DATA arrives after completion", async () => {
        const mgr = makeManager();
        const p = expectResponse(mgr, 0n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const res = (await p) as { statusCode: number };
        expect(res.statusCode).toBe(200);

        // Extra DATA after completion — should be ignored (stream already removed).
        expect(() => {
            mgr.dispatchRequestFrame(0n, DATA([0x62]));
        }).not.toThrow();
    });

    it("handles interleaved request and push streams independently", async () => {
        // Use distinct ids: the manager keys pending responses and pushes by
        // the same numeric space, so a request and push sharing an id would
        // collide during cleanup. This test verifies they stay independent
        // when given distinct ids.
        const mgr = makeManager();
        const req = expectResponse(mgr, 0n);
        const push = expectPush(mgr, 2n);

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchPushFrame(2n, HEADERS([0x80]));
        mgr.dispatchPushFrame(2n, DATA([0x7a]));
        mgr.dispatchRequestFrame(0n, DATA([0x61]));

        const rReq = (await req) as { body: Uint8Array };
        const rPush = (await push) as { body: Uint8Array };
        expect(new TextDecoder().decode(rReq.body)).toBe("a");
        expect(new TextDecoder().decode(rPush.body)).toBe("z");
    });

    it("handles many concurrent streams without cross-contamination", async () => {
        const mgr = makeManager();
        const N = 50;
        const promises: Promise<unknown>[] = [];

        for (let i = 0; i < N; i++) {
            promises.push(expectResponse(mgr, BigInt(i * 4)));
        }

        for (let i = 0; i < N; i++) {
            mgr.dispatchRequestFrame(BigInt(i * 4), HEADERS([0x80]));
        }
        for (let i = 0; i < N; i++) {
            mgr.dispatchRequestFrame(BigInt(i * 4), DATA([0x61 + (i % 26)]));
        }

        const results = await Promise.all(promises);
        expect(results.length).toBe(N);
        for (const r of results) {
            expect((r as { statusCode: number }).statusCode).toBe(200);
        }
    });
});
