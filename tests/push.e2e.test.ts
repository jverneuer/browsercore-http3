/**
 * HTTP/3 server push end-to-end (PLAN.md Step 9).
 *
 * Exercises the full push path over a fake QUIC connection:
 *   - PUSH_PROMISE on a request stream triggers push stream acceptance.
 *   - The push stream HEADERS + DATA resolve a pushed response.
 *   - CANCEL_PUSH rejects the push with PushCancelledError.
 *
 * Server push is receive-only: this package never initiates push, it only
 * consumes push from the peer.
 */

import { describe, it, expect } from "vitest";
import { connectHttp3 } from "../src/connection.js";
import { FakeQuic } from "./fake-quic.js";
import { FrameReader, serializeFrame } from "../src/frame/frame.js";
import { encodeHeaders } from "../src/qpack/qpack.js";
import { Http3FrameType } from "../src/types.js";
import { PushCancelledError } from "../src/errors.js";
import type { QuicConnection, QuicStream } from "../src/types.js";

async function drivePushServer(server: QuicConnection): Promise<void> {
    const clientControl = await server.acceptUnidirectionalStream().catch(() => null);
    if (!clientControl) return;
    await clientControl.read().catch(() => {});
    await server.acceptUnidirectionalStream().catch(() => null);
    await server.acceptUnidirectionalStream().catch(() => null);
    const serverControl = await server.openUnidirectionalStream().catch(() => null);
    if (!serverControl) return;
    await serverControl.write(new Uint8Array([0x0])).catch(() => {});
    await server.openUnidirectionalStream().catch(() => null);
    await server.openUnidirectionalStream().catch(() => null);
    const ctlReader = new FrameReader(async () => clientControl.read());
    await ctlReader.readFrame().catch(() => {});
    await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} })).catch(() => {});
    let nextPushId = 0n;
    for (;;) {
        let stream: QuicStream;
        try {
            stream = await server.acceptBidirectionalStream();
        } catch {
            return;
        }
        void (async () => {
            try {
                const reqReader = new FrameReader(async () => stream.read());
                await reqReader.readFrame();
                await reqReader.readFrame();
                const pushId = nextPushId;
                nextPushId += 2n;
                const promiseHeaders = encodeHeaders(
                    new Map([[":method", "GET"], [":scheme", "https"], [":authority", "example.com"], [":path", "/pushed.css"]]),
                );
                await stream.write(serializeFrame({ type: Http3FrameType.PUSH_PROMISE, pushId, payload: promiseHeaders }));
                const pushStream = await server.openUnidirectionalStream();
                await pushStream.write(new Uint8Array([0x1]));
                const pushedHeaders = encodeHeaders(
                    new Map([[":status", "200"], ["content-type", "text/css"]]),
                );
                await pushStream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: pushedHeaders }));
                await pushStream.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([0x7b, 0x7d]) }));
                const respHeaders = encodeHeaders(
                    new Map([[":status", "200"], ["content-type", "text/html"]]),
                );
                await stream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
                await stream.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
            } catch {
                // stream done
            }
        })();
    }
}

async function driveCancelPushServer(server: QuicConnection): Promise<void> {
    const clientControl = await server.acceptUnidirectionalStream().catch(() => null);
    if (!clientControl) return;
    await clientControl.read().catch(() => {});
    await server.acceptUnidirectionalStream().catch(() => null);
    await server.acceptUnidirectionalStream().catch(() => null);
    const serverControl = await server.openUnidirectionalStream().catch(() => null);
    if (!serverControl) return;
    await serverControl.write(new Uint8Array([0x0])).catch(() => {});
    await server.openUnidirectionalStream().catch(() => null);
    await server.openUnidirectionalStream().catch(() => null);
    const ctlReader = new FrameReader(async () => clientControl.read());
    await ctlReader.readFrame().catch(() => {});
    await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} })).catch(() => {});
    for (;;) {
        let stream: QuicStream;
        try {
            stream = await server.acceptBidirectionalStream();
        } catch {
            return;
        }
        void (async () => {
            try {
                const reqReader = new FrameReader(async () => stream.read());
                await reqReader.readFrame();
                await reqReader.readFrame();
                const promiseHeaders = encodeHeaders(
                    new Map([[":method", "GET"], [":scheme", "https"], [":authority", "example.com"], [":path", "/cancelled"]]),
                );
                await stream.write(serializeFrame({ type: Http3FrameType.PUSH_PROMISE, pushId: 0n, payload: promiseHeaders }));
                await serverControl.write(serializeFrame({ type: Http3FrameType.CANCEL_PUSH, pushId: 0n }));
                const respHeaders = encodeHeaders(
                    new Map([[":status", "200"], ["content-type", "text/html"]]),
                );
                await stream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
                await stream.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
            } catch {
                // stream done
            }
        })();
    }
}

describe("HTTP/3 server push (Step 9)", () => {
    it("resolves a pushed response from a PUSH_PROMISE + push stream", async () => {
        const quic = new FakeQuic();
        const serverDone = drivePushServer(quic.server);
        const conn = await connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const reqPromise = conn.request({
            method: "GET", scheme: "https", authority: "example.com", path: "/index.html",
            headers: new Map(), body: undefined,
        });
        const pushed = await conn.push();
        expect(pushed.statusCode).toBe(200);
        expect(pushed.headers.get("content-type")).toBe("text/css");
        expect(new TextDecoder().decode(pushed.body)).toBe("{}");
        const res = await reqPromise;
        expect(res.statusCode).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/html");
        await conn.close();
        await serverDone;
    }, 10000);

    it("rejects push() with PushCancelledError when the peer cancels the push", async () => {
        const quic = new FakeQuic();
        const serverDone = driveCancelPushServer(quic.server);
        const conn = await connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const reqPromise = conn.request({
            method: "GET", scheme: "https", authority: "example.com", path: "/index.html",
            headers: new Map(), body: undefined,
        });
        await expect(conn.push()).rejects.toBeInstanceOf(PushCancelledError);
        const res = await reqPromise;
        expect(res.statusCode).toBe(200);
        await conn.close();
        await serverDone;
    }, 10000);
});
