/**
 * HTTP/3 stream manager (PLAN.md Step 5).
 *
 * Verifies control-stream dispatch (SETTINGS/GOAWAY/MAX_PUSH_ID), bidirectional
 * request/response correlation, push streams, and abort-all. The manager is
 * I/O-free, so it is driven with parsed Http3Frame objects and a fake header
 * decoder.
 */

import { describe, it, expect } from "vitest";
import { createStreamManager } from "../src/stream/stream.js";
import { Http3FrameType, type Http3Frame } from "../src/types.js";

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

describe("control stream dispatch", () => {
    it("emits a 'settings' event when a SETTINGS frame arrives", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let seen = false;
        mgr.on("settings", () => {
            seen = true;
        });
        mgr.dispatchControlFrame(SETTINGS());
        expect(seen).toBe(true);
    });

    it("emits a 'goaway' event with the stream id", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let got: bigint | undefined;
        mgr.on("goaway", (id: bigint) => {
            got = id;
        });
        mgr.dispatchControlFrame(GOAWAY(100n));
        expect(got).toBe(100n);
    });

    it("emits a 'maxPushId' event with the push id", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        let got: bigint | undefined;
        mgr.on("maxPushId", (id: bigint) => {
            got = id;
        });
        mgr.dispatchControlFrame(MAX_PUSH_ID(8n));
        expect(got).toBe(8n);
    });
});

describe("bidirectional request/response correlation", () => {
    it("resolves a registered response when HEADERS + DATA arrive", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));

        const result = new Promise((resolve, reject) => {
            mgr.expectResponse(0n, resolve, reject);
        });

        mgr.dispatchRequestFrame(0n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(0n, DATA([0x61, 0x62]));

        const res = (await result) as { statusCode: number; body: Uint8Array };
        expect(res.statusCode).toBe(200);
        expect(new TextDecoder().decode(res.body)).toBe("ab");
    });

    it("ignores frames for unknown streams", () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.dispatchRequestFrame(4n, HEADERS([0x80]));
        mgr.dispatchRequestFrame(4n, DATA([0x61]));
    });
});

describe("abortAll", () => {
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

describe("push streams", () => {
    it("correlates a push response by push id", async () => {
        const mgr = createStreamManager({ sendGoaway: () => {}, sendCancelPush: () => {} });
        mgr.setHeaderDecoder(() => new Map([[":status", "200"]]));

        const result = new Promise((resolve, reject) => {
            mgr.expectPush(2n, resolve, reject);
        });

        mgr.dispatchPushFrame(2n, HEADERS([0x80]));
        mgr.dispatchPushFrame(2n, DATA([0x7a]));

        const res = (await result) as { statusCode: number };
        expect(res.statusCode).toBe(200);
    });
});
