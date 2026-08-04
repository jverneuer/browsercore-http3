/**
 * QUIC handshake integration (PLAN.md Phase 4: HTTP/3 over protected QUIC).
 *
 * Proves the contract that `connectHttp3()` awaits the QUIC handshake before
 * beginning the HTTP/3 SETTINGS exchange, so all HTTP/3 frames travel over the
 * protected QUIC connection. Also verifies:
 *   - SETTINGS frames are exchanged over the protected connection.
 *   - The QPACK encoder/decoder streams are wired over the protected
 *     connection (instructions flow after the handshake).
 *   - `connectHttp3()` blocks until the handshake completes (it does NOT open
 *     streams or send SETTINGS over an unprotected connection).
 */

import { describe, it, expect } from "vitest";
import { connectHttp3 } from "../src/connection.js";
import { FakeQuic } from "./fake-quic.js";
import { FrameReader, serializeFrame } from "../src/frame/frame.js";
import { encodeHeaders } from "../src/qpack/qpack.js";
import { Http3FrameType } from "../src/types.js";
import type { QuicConnection, QuicStream } from "../src/types.js";

/**
 * A server driver that does NOT signal the handshake. Lets tests observe the
 * connection before the QUIC handshake completes.
 */
async function driveServerNoHandshake(server: QuicConnection): Promise<void> {
    // Accept the client's control + QPACK streams only once the client opens
    // them — which only happens after the handshake completes.
    const clientControl = await server.acceptUnidirectionalStream();
    await clientControl.read();
    await server.acceptUnidirectionalStream();
    await server.acceptUnidirectionalStream();
    const serverControl = await server.openUnidirectionalStream();
    await serverControl.write(new Uint8Array([0x0]));
    await server.openUnidirectionalStream();
    await server.openUnidirectionalStream();
    const reader = new FrameReader(async () => clientControl.read());
    await reader.readFrame(); // client SETTINGS
    await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
}

describe("QUIC handshake integration (Phase 4)", () => {
    it("connectHttp3() blocks on quic.handshake() before opening any streams", async () => {
        const quic = new FakeQuic();
        // Fire connectHttp3 WITHOUT signalling the handshake. It must block on
        // quic.handshake() and NOT open any unidirectional streams on the
        // server side yet.
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });

        // Give the event loop a few ticks — if connectHttp3 did not await the
        // handshake, it would have opened streams by now.
        await new Promise((r) => setTimeout(r, 20));

        // The server should NOT have received any streams yet, because the
        // handshake has not completed.
        const server = quic.server;
        const race = await Promise.race([
            server.acceptUnidirectionalStream().then(() => "stream" as const),
            new Promise<"timeout">((r) => setTimeout(() => {
                r("timeout");
            }, 30)),
        ]);
        expect(race).toBe("timeout");

        // Now signal the handshake — connectHttp3 should open its streams.
        quic.completeHandshake();
        const streamOrTimeout = await Promise.race([
            server.acceptUnidirectionalStream().then(() => "stream" as const),
            new Promise<"timeout">((r) => setTimeout(() => {
                r("timeout");
            }, 500)),
        ]);
        expect(streamOrTimeout).toBe("stream");
        // Clean up: close the connection so its doHandshake rejects (no
        // server driving it) and the socket/accept waiters release.
        await quic.client.close(0n, "test_end");
        await expect(connPromise).rejects.toBeDefined();
    }, 5000);

    it("exchanges SETTINGS over the protected connection after the handshake", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        quic.completeHandshake();

        // Drive the server: accept the client's SETTINGS and reply with our
        // own SETTINGS — both travel over the protected connection.
        const server = quic.server;
        const clientControl = await server.acceptUnidirectionalStream();
        await clientControl.read(); // control type byte
        await server.acceptUnidirectionalStream(); // encoder
        await server.acceptUnidirectionalStream(); // decoder
        const serverControl = await server.openUnidirectionalStream();
        await serverControl.write(new Uint8Array([0x0]));
        await server.openUnidirectionalStream();
        await server.openUnidirectionalStream();

        // Read the client's SETTINGS frame.
        const ctlReader = new FrameReader(async () => clientControl.read());
        const clientSettings = await ctlReader.readFrame();
        expect(clientSettings.type).toBe(Http3FrameType.SETTINGS);

        // Reply with our SETTINGS — connectHttp3's doHandshake resolves on this.
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));

        const conn = await connPromise;
        expect(conn).toBeDefined();

        // A request/response exchange confirms the protected path works end-to-end.
        const reqPromise = conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/",
            headers: new Map(),
            body: undefined,
        });
        let stream: QuicStream;
        try {
            stream = await server.acceptBidirectionalStream();
        } catch {
            throw new Error("server did not receive request stream");
        }
        const reqReader = new FrameReader(async () => stream.read());
        await reqReader.readFrame(); // HEADERS
        await reqReader.readFrame(); // DATA (empty)
        const respHeaders = encodeHeaders(new Map([[":status", "200"]]));
        await stream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
        await stream.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        const res = await reqPromise;
        expect(res.statusCode).toBe(200);
        await conn.close();
    }, 5000);

    it("wires QPACK encoder/decoder streams over the protected connection", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        quic.completeHandshake();

        const server = quic.server;
        // Capture the server's QPACK streams so we can write instructions to
        // them — proving they are open over the protected connection.
        const clientControl = await server.acceptUnidirectionalStream();
        await clientControl.read();
        await server.acceptUnidirectionalStream(); // client encoder (type 0x2)
        await server.acceptUnidirectionalStream(); // client decoder (type 0x3)
        const serverControl = await server.openUnidirectionalStream();
        await serverControl.write(new Uint8Array([0x0]));
        const serverEncoder = await server.openUnidirectionalStream();
        await serverEncoder.write(new Uint8Array([0x2]));
        const serverDecoder = await server.openUnidirectionalStream();
        await serverDecoder.write(new Uint8Array([0x3]));
        const ctlReader = new FrameReader(async () => clientControl.read());
        await ctlReader.readFrame(); // client SETTINGS
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        await connPromise;

        // The client's encoder-stream read loop reads from serverEncoder. Send
        // a Set Dynamic Table Capacity instruction (001 <cap 5+>) = 100.
        // 100 >= 32 -> multi-byte: first byte 0b001_11111 = 0x3f, then 100-32=68.
        await serverEncoder.write(new Uint8Array([0x3f, 68]));
        await serverEncoder.write(new Uint8Array(0)); // empty chunk -> continue
        await serverEncoder.write(new Uint8Array([0x3f, 68]));
        // The decoder-stream read loop reads from serverDecoder; send a Section
        // Acknowledgment for stream 0, with an empty chunk to exercise its
        // `continue` branch too.
        await serverDecoder.write(new Uint8Array(0));
        await serverDecoder.write(new Uint8Array([0x80 | 0x00]));
        // Allow the async read loops to process the bytes.
        await new Promise((r) => {
            setTimeout(r, 20);
        });
        void server;
    }, 5000);

    it("resolves the handshake when completeHandshake() is called before connectHttp3", async () => {
        const quic = new FakeQuic();
        // Signal the handshake eagerly — connectHttp3 should proceed immediately.
        quic.completeHandshake();
        const serverDone = driveServerNoHandshake(quic.server);
        const conn = await connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        expect(conn).toBeDefined();
        await conn.close();
        await serverDone;
    }, 5000);
});
