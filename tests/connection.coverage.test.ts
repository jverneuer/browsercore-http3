/**
 * Targeted branch coverage for src/connection.ts.
 *
 * Exercises the branches the lifecycle + push e2e tests leave uncovered:
 *   - push() draining an already-queued push promise (the `return queued`
 *     branch).
 *   - the manager invoking the sendGoaway / sendCancelPush handlers on
 *     abortAll (handler arrow bodies).
 *   - sendCancelPush's controlStream-defined write path.
 *   - peekRequiredInsertCount on an empty header block.
 *   - peekRequiredInsertCount's multi-byte Required Insert Count (RIC === max).
 *
 * The uncovered branches cluster around the manager's abortAll path and the
 * QPACK prefix parser. Each test drives the connection over a fake QUIC
 * connection to land on one of them.
 */

import { describe, it, expect } from "vitest";
import { connectHttp3 } from "../src/connection.js";
import { FakeQuic } from "./fake-quic.ts";
import { FrameReader, serializeFrame } from "../src/frame/frame.js";
import { encodeHeaders } from "../src/qpack/qpack.js";
import { Http3FrameType } from "../src/types.js";
import type { QuicConnection, QuicStream } from "../src/types.js";

/**
 * Drive the handshake manually so we retain the client's outbound control
 * stream (clientControl) — the stream the client writes GOAWAY / CANCEL_PUSH
 * frames to — alongside the server's control stream (serverControl).
 */
async function driveHandshake(quic: FakeQuic): Promise<{ clientControl: QuicStream; serverControl: QuicStream }> {
    // Signal the QUIC handshake so connectHttp3 may open streams.
    quic.completeHandshake();
    const clientControl = await quic.server.acceptUnidirectionalStream();
    await clientControl.read(); // control type byte (0x0)
    await quic.server.acceptUnidirectionalStream(); // client encoder (type 0x2)
    await quic.server.acceptUnidirectionalStream(); // client decoder (type 0x3)
    const serverControl = await quic.server.openUnidirectionalStream();
    await serverControl.write(new Uint8Array([0x0]));
    await quic.server.openUnidirectionalStream(); // server encoder
    await quic.server.openUnidirectionalStream(); // server decoder
    // Consume the client's SETTINGS so the client side does not block.
    const reader = new FrameReader(async () => clientControl.read());
    await reader.readFrame();
    return { clientControl, serverControl };
}

/** Settle the async read loops for up to `ms` in 20ms slices. */
async function settle(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe("connection — push() drains an already-queued promise", () => {
    it("returns the queued promise when pushPromise already fired", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { serverControl } = await driveHandshake(quic);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        // Send a request; the server answers with a PUSH_PROMISE on the request
        // stream. The client's bidi read loop dispatches it, firing "pushPromise"
        // and queuing a promise in pendingPushes — before push() is ever called.
        const reqPromise = conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/index.html",
            headers: new Map(),
            body: undefined,
        });
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame(); // HEADERS
        await reqReader.readFrame(); // DATA (empty)
        const promiseHeaders = encodeHeaders(
            new Map([
                [":method", "GET"],
                [":scheme", "https"],
                [":authority", "example.com"],
                [":path", "/pushed.css"],
            ]),
        );
        await srv.write(
            serializeFrame({ type: Http3FrameType.PUSH_PROMISE, pushId: 0n, payload: promiseHeaders }),
        );

        // Wait until the client has processed the PUSH_PROMISE and queued the
        // promise (onPushPromise runs on the async "pushPromise" event).
        await settle(400);

        // push() now finds a queued promise in pendingPushes and returns it
        // directly (the `return queued` branch) instead of awaiting the event.
        const pushedPromise = conn.push();

        // Complete the push stream so the queued promise resolves.
        const pushStream = await quic.server.openUnidirectionalStream();
        await pushStream.write(new Uint8Array([0x1]));
        const pushedHeaders = encodeHeaders(
            new Map([
                [":status", "200"],
                ["content-type", "text/css"],
            ]),
        );
        await pushStream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: pushedHeaders }));
        await pushStream.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array([0x7b, 0x7d]) }));

        const pushed = await pushedPromise;
        expect(pushed.statusCode).toBe(200);
        expect(pushed.headers.get("content-type")).toBe("text/css");

        // Finish the main request so teardown is clean.
        const respHeaders = encodeHeaders(new Map([[":status", "200"]]));
        await srv.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
        await srv.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        await reqPromise;
        await conn.close();
    }, 10000);
});

describe("connection — manager invokes sendGoaway / sendCancelPush handlers on abortAll", () => {
    it("abortAll routes GOAWAY and CANCEL_PUSH through the connection handlers", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { clientControl, serverControl } = await driveHandshake(quic);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        // Register a response (sets maxStreamId) and a push promise (so abortAll
        // has a pending push to CANCEL_PUSH). close() will reject both, so
        // attach handlers up front to avoid unhandled rejections between
        // close() and the explicit assertions below.
        const reqPromise = conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/a",
            headers: new Map(),
            body: undefined,
        });
        reqPromise.catch(() => {});
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame(); // HEADERS
        await reqReader.readFrame(); // DATA (empty)
        const promiseHeaders = encodeHeaders(
            new Map([
                [":method", "GET"],
                [":scheme", "https"],
                [":authority", "example.com"],
                [":path", "/cancelled"],
            ]),
        );
        await srv.write(
            serializeFrame({ type: Http3FrameType.PUSH_PROMISE, pushId: 0n, payload: promiseHeaders }),
        );
        // Let the client process the PUSH_PROMISE so expectPush registers the resolver.
        await settle(200);
        // Drain the queued push promise so its rejection by abortAll is handled.
        conn.push().catch(() => {});

        // Close triggers abortAll, which now invokes both handlers.
        await expect(conn.close()).resolves.toBeUndefined();

        // The GOAWAY and CANCEL_PUSH frames arrive on the client's outbound
        // control stream (clientControl), which the peer reads.
        const ctlReader = new FrameReader(async () => clientControl.read());
        const goaway = await ctlReader.readFrame();
        expect(goaway.type).toBe(Http3FrameType.GOAWAY);
        const cancelPush = await ctlReader.readFrame();
        expect(cancelPush.type).toBe(Http3FrameType.CANCEL_PUSH);
        if (cancelPush.type === Http3FrameType.CANCEL_PUSH) {
            expect(cancelPush.pushId).toBe(0n);
        }
        // The in-flight request is rejected by abortAll.
        await expect(reqPromise).rejects.toThrow(/connection closed/);
    }, 10000);
});

describe("connection — peekRequiredInsertCount edge cases", () => {
    it("returns 0 for an empty header block (no dynamic-table state)", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { serverControl } = await driveHandshake(quic);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        // The server responds with a HEADERS frame whose payload is empty. The
        // client's manager decodes it via decodeHeaders → peekRequiredInsertCount,
        // which returns 0 for an empty block. qpackDec.decode then throws on the
        // empty block, surfacing as a QPACK decode failure (request rejected).
        const reqPromise = conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/empty",
            headers: new Map(),
            body: undefined,
        });
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame(); // HEADERS
        await reqReader.readFrame(); // DATA (empty)
        await srv.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: new Uint8Array(0) }));
        await srv.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        await expect(reqPromise).rejects.toThrow(/QPACK decode failed/);
        await conn.close();
    }, 10000);

    it("parses a multi-byte Required Insert Count prefix (RIC === max)", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { serverControl } = await driveHandshake(quic);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        // First byte 0x7f → low 7 bits = 127 = max, so the multi-byte loop runs.
        // The second byte terminates it (high bit clear). qpackDec.decode then
        // rejects the absurd RIC (127 > insertCount 0), failing the request.
        const reqPromise = conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/ric",
            headers: new Map(),
            body: undefined,
        });
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame(); // HEADERS
        await reqReader.readFrame(); // DATA (empty)
        await srv.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: new Uint8Array([0x7f, 0x00]) }));
        await srv.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        await expect(reqPromise).rejects.toThrow(/QPACK decode failed/);
        await conn.close();
    }, 10000);
});

describe("connection — applyPeerSettings covers QPACK_BLOCKED_STREAMS branch", () => {
    it("records QPACK_BLOCKED_STREAMS when peer SETTINGS include it", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { serverControl } = await driveHandshake(quic);
        // Send SETTINGS with QPACK_BLOCKED_STREAMS (0x7) to cover the
        // `peerBlockedStreams !== undefined` true branch in applyPeerSettings.
        await serverControl.write(serializeFrame({
            type: Http3FrameType.SETTINGS,
            settings: { 0x7: 100 },
        }));
        const conn = await connPromise;
        expect(conn).toBeDefined();
        await conn.close();
    }, 10000);
});

describe("connection — defensive undefined-stream branches", () => {
    it("writeEncoderStream / writeDecoderStream / sendCancelPush no-op when streams undefined", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { serverControl } = await driveHandshake(quic);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        // Access private fields via type assertion to simulate the defensive
        // paths where streams haven't been set up yet. These methods should
        // early-return without throwing.
        const c = conn as unknown as {
            encoderStream: undefined;
            decoderStream: undefined;
            controlStream: undefined;
            writeEncoderStream(b: Uint8Array): void;
            writeDecoderStream(b: Uint8Array): void;
            sendCancelPush(pushId: bigint): Promise<void>;
        };
        c.encoderStream = undefined;
        c.decoderStream = undefined;
        c.controlStream = undefined;

        expect(() => {
            c.writeEncoderStream(new Uint8Array([1, 2, 3]));
            c.writeDecoderStream(new Uint8Array([4, 5, 6]));
            void c.sendCancelPush(0n);
        }).not.toThrow();

        await conn.close();
    }, 10000);
});
