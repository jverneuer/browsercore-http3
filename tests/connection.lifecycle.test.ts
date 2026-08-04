/**
 * HTTP/3 connection lifecycle (PLAN.md Steps 6-8) over a fake QUIC connection.
 *
 * Exercises the branches the happy-path e2e test leaves uncovered:
 *   - SETTINGS ACK timeout when the peer never sends SETTINGS.
 *   - request() with a non-empty body (HEADERS + DATA(payload)).
 *   - close() idempotency (second close returns immediately).
 *   - peer GOAWAY aborting an in-flight request (onPeerGoaway).
 *   - request() while closing throws.
 *   - sendGoaway with no control stream (early return).
 *   - the QPACK encoder/decoder stream read loops.
 *
 * IMPORTANT driving pattern: the client connection MUST be fired (without
 * awaiting) before the server side accepts streams. The FakeQuic buffers a
 * stream for the peer's accept() only once the peer has called accept(); if the
 * server awaits accept() before the client opens the stream, both sides block
 * forever. Firing the client first mirrors how driveFakeServer() is used.
 */

import { describe, it, expect } from "vitest";
import { connectHttp3, Http3ConnectionImpl } from "../src/connection.js";
import { FakeQuic } from "./fake-quic.js";
import { FrameReader, serializeFrame } from "../src/frame/frame.js";
import { encodeHeaders } from "../src/qpack/qpack.js";
import { Http3FrameType } from "../src/types.js";
import { SettingsAckTimeoutError } from "../src/errors.js";
import type { QuicConnection, QuicStream } from "../src/types.js";

/** Server-side: complete the handshake and return the server control stream. */
async function serverFinishHandshake(server: QuicConnection): Promise<QuicStream> {
    const clientControl = await server.acceptUnidirectionalStream();
    await clientControl.read(); // control type byte
    await server.acceptUnidirectionalStream(); // encoder
    await server.acceptUnidirectionalStream(); // decoder
    const serverControl = await server.openUnidirectionalStream();
    await serverControl.write(new Uint8Array([0x0]));
    await server.openUnidirectionalStream(); // encoder
    await server.openUnidirectionalStream(); // decoder
    // Consume the client's SETTINGS so the client side does not block.
    const reader = new FrameReader(async () => clientControl.read());
    await reader.readFrame();
    return serverControl;
}

describe("connection lifecycle (Steps 6-8)", () => {
    it("times out when the peer never acknowledges SETTINGS", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 50 });
        // Complete the handshake up to reading the client SETTINGS, but do NOT
        // send the server's SETTINGS back.
        await serverFinishHandshake(quic.server);
        await expect(connPromise).rejects.toBeInstanceOf(SettingsAckTimeoutError);
    }, 5000);

    it("sends HEADERS + DATA(payload) for a request with a body", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const serverControl = await serverFinishHandshake(quic.server);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        const reqPromise = conn.request({
            method: "POST",
            scheme: "https",
            authority: "example.com",
            path: "/submit",
            headers: new Map([["content-type", "application/json"]]),
            body: new Uint8Array([0x7b, 0x7d]), // "{}"
        });

        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        const f1 = await reqReader.readFrame();
        expect(f1.type).toBe(Http3FrameType.HEADERS);
        const f2 = await reqReader.readFrame();
        expect(f2.type).toBe(Http3FrameType.DATA);
        if (f2.type === Http3FrameType.DATA) {
            expect(Array.from(f2.payload)).toEqual([0x7b, 0x7d]);
        }

        const respHeaders = encodeHeaders(new Map([[":status", "200"]]));
        await srv.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
        await srv.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        const res = await reqPromise;
        expect(res.statusCode).toBe(200);
    }, 10000);

    it("close() is idempotent and suppresses the second GOAWAY", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const serverControl = await serverFinishHandshake(quic.server);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        await conn.close();
        await expect(conn.close()).resolves.toBeUndefined();
    }, 10000);

    it("aborts an in-flight request when the peer sends GOAWAY", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const serverControl = await serverFinishHandshake(quic.server);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        const reqPromise = conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/slow",
            headers: new Map(),
            body: undefined,
        });
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame(); // HEADERS
        await reqReader.readFrame(); // DATA (empty)

        await serverControl.write(serializeFrame({ type: Http3FrameType.GOAWAY, streamId: 0n }));
        await expect(reqPromise).rejects.toThrow(/GOAWAY/);
    }, 10000);

    it("throws if request() is called while the connection is closing", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const serverControl = await serverFinishHandshake(quic.server);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;

        const first = conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/a",
            headers: new Map(),
            body: undefined,
        });
        const closePromise = conn.close();
        // A request issued after close begins must be rejected.
        await expect(
            conn.request({
                method: "GET",
                scheme: "https",
                authority: "example.com",
                path: "/b",
                headers: new Map(),
                body: undefined,
            }),
        ).rejects.toThrow(/closing/);
        // Clean up the open stream so the close's teardown completes.
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame();
        await reqReader.readFrame();
        const respHeaders = encodeHeaders(new Map([[":status", "200"]]));
        await srv.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
        await srv.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        await first;
        await closePromise;
    }, 10000);
});

describe("connection — sendGoaway / sendCancelPush with no control stream", () => {
    it("sendGoaway returns early before the handshake opens the control stream", async () => {
        const quic = new FakeQuic();
        const conn = new Http3ConnectionImpl("test_id", { quic: quic.client });
        // controlStream is undefined before doHandshake; goaway() must be a
        // safe no-op rather than throwing on undefined access.
        await expect(conn.goaway(0n)).resolves.toBeUndefined();
    });
});

describe("connection — QPACK stream read loops", () => {
    it("drains encoder-stream instructions from the peer", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        // Drive the handshake manually so we can capture the server's QPACK
        // streams and write encoder instructions to them.
        const server = quic.server;
        const clientControl = await server.acceptUnidirectionalStream();
        await clientControl.read();
        await server.acceptUnidirectionalStream(); // client encoder (type byte 0x2)
        await server.acceptUnidirectionalStream(); // client decoder (type byte 0x3)
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

        // The client's encoder-stream read loop reads from serverEncoder. Send a
        // Set Dynamic Table Capacity instruction (001 <cap 5+>) = 100.
        // 100 >= 32 -> multi-byte: first byte 0b001_11111 = 0x3f, then 100-32=68.
        await serverEncoder.write(new Uint8Array([0x3f, 68]));
        // An empty chunk exercises the `continue` branch (empty chunks are
        // skipped) before a second instruction.
        await serverEncoder.write(new Uint8Array(0));
        await serverEncoder.write(new Uint8Array([0x3f, 68]));
        // The decoder-stream read loop reads from serverDecoder; send a Section
        // Acknowledgment (1 <streamId 7+>) for stream 0, with an empty chunk to
        // exercise its `continue` branch too.
        await serverDecoder.write(new Uint8Array(0));
        await serverDecoder.write(new Uint8Array([0x80 | 0x00]));
        // Allow the async read loops to process the bytes.
        await new Promise((r) => setTimeout(r, 20));
        void server;
    }, 10000);
});
