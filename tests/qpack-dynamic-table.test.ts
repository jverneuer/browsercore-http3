/**
 * QPACK dynamic-table integration over the HTTP/3 connection (Plan 10).
 */
import { describe, it, expect } from "vitest";
import { connectHttp3, Http3ConnectionImpl } from "../src/connection.js";
import { FakeQuic } from "./fake-quic.js";
import { FrameReader, serializeFrame } from "../src/frame/frame.js";
import {
    encodeHeaders,
    QpackEncoder,
    QpackDecoder,
    QpackDynamicTable,
} from "../src/qpack/qpack.js";
import { Http3FrameType, Http3Settings, type QuicConnection, type QuicStream } from "../src/types.js";

async function serverFinishHandshakeWithQpack(quic: FakeQuic): Promise<{
    serverControl: QuicStream;
    serverEncoder: QuicStream;
    serverDecoder: QuicStream;
    clientEncoder: QuicStream;
    clientDecoder: QuicStream;
}> {
    // Signal the QUIC handshake so connectHttp3 may open streams.
    quic.completeHandshake();
    const clientControl = await quic.server.acceptUnidirectionalStream();
    await clientControl.read();
    const clientEncoder = await quic.server.acceptUnidirectionalStream();
    const clientDecoder = await quic.server.acceptUnidirectionalStream();
    const serverControl = await quic.server.openUnidirectionalStream();
    await serverControl.write(new Uint8Array([0x0]));
    const serverEncoder = await quic.server.openUnidirectionalStream();
    await serverEncoder.write(new Uint8Array([0x2]));
    const serverDecoder = await quic.server.openUnidirectionalStream();
    await serverDecoder.write(new Uint8Array([0x3]));
    const reader = new FrameReader(async () => clientControl.read());
    await reader.readFrame();
    return { serverControl, serverEncoder, serverDecoder, clientEncoder, clientDecoder };
}

describe("QPACK dynamic table — encoder wiring into request()", () => {
    it("writes encoder instructions on the client's encoder stream", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({
            quic: quic.client,
            settingsAckTimeoutMs: 5000,
            initialSettings: { [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 1024 },
        });
        const { serverControl, clientEncoder } = await serverFinishHandshakeWithQpack(quic);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;
        const typeByte = await clientEncoder.read();
        expect(Array.from(typeByte)).toEqual([0x2]);
        const reqPromise = conn.request({
            method: "GET", scheme: "https", authority: "example.com", path: "/",
            headers: new Map([["x-custom-header", "custom-value"]]), body: undefined,
        });
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame();
        await reqReader.readFrame();
        const encChunk = await clientEncoder.read();
        expect(encChunk.length).toBeGreaterThan(0);
        expect((encChunk[0]! & 0xe0)).toBe(0x40);
        const respHeaders = encodeHeaders(new Map([[":status", "200"]]));
        await srv.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
        await srv.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        const res = await reqPromise;
        expect(res.statusCode).toBe(200);
        await conn.close();
    }, 20000);
});

describe("QPACK dynamic table — SETTINGS_QPACK_MAX_TABLE_CAPACITY flow control", () => {
    it("applies peer capacity via Set Capacity on encoder stream", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { serverControl, clientEncoder } = await serverFinishHandshakeWithQpack(quic);
        await serverControl.write(serializeFrame({
            type: Http3FrameType.SETTINGS,
            settings: { [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 512 },
        }));
        const conn = await connPromise;
        await new Promise((r) => setTimeout(r, 10));
        const chunk1 = await clientEncoder.read();
        expect(Array.from(chunk1)).toEqual([0x2]);
        const chunk2 = await clientEncoder.read();
        expect(chunk2.length).toBeGreaterThan(0);
        expect(chunk2[0]).toBe(0x3f);
        expect(chunk2[1]).toBe(0xe1);
        expect(chunk2[2]).toBe(0x03);
        await conn.close();
    }, 20000);
});

describe("QPACK dynamic table — decoder-stream read loop", () => {
    it("processes Section Ack, Stream Cancellation, Insert Count Increment", async () => {
        const quic = new FakeQuic();
        const connPromise = connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });
        const { serverControl, serverDecoder } = await serverFinishHandshakeWithQpack(quic);
        await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));
        const conn = await connPromise;
        const reqPromise = conn.request({
            method: "GET", scheme: "https", authority: "example.com", path: "/",
            headers: new Map(), body: undefined,
        });
        const srv = await quic.server.acceptBidirectionalStream();
        const reqReader = new FrameReader(async () => srv.read());
        await reqReader.readFrame();
        await reqReader.readFrame();
        await serverDecoder.write(new Uint8Array([0x40, 0x00, 0x83]));
        await expect(reqPromise).rejects.toThrow(/cancelled/);
        await conn.close();
    }, 20000);
});

describe("QPACK dynamic table — encoder round-trip", () => {
    it("round-trips with dynamic insert + post-base ref", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.setEncoderCapacity(1024);
        dec.applyMaxCapacity(1024);
        const first = enc.encode(new Map([[":method", "GET"], ["x-one", "1"], ["x-two", "2"]]));
        dec.consumeEncoderStream(first.encoderBytes);
        const decodedFirst = dec.decode(first.block, first.requiredInsertCount);
        expect(decodedFirst.get(":method")).toBe("GET");
        expect(decodedFirst.get("x-one")).toBe("1");
        const second = enc.encode(new Map([[":method", "GET"], ["x-one", "1"], ["x-two", "2"]]));
        expect(second.encoderBytes.length).toBe(0);
        dec.consumeEncoderStream(second.encoderBytes);
        const decodedSecond = dec.decode(second.block, second.requiredInsertCount);
        expect(decodedSecond.get(":method")).toBe("GET");
        expect(decodedSecond.get("x-one")).toBe("1");
    });

    it("setEncoderCapacity emits Set Capacity instruction", () => {
        const enc = new QpackEncoder();
        const capBytes = enc.setEncoderCapacity(1024);
        expect(Array.from(capBytes)).toEqual([0x3f, 0xe1, 0x07]);
        expect(enc.capacity).toBe(1024);
    });

    it("emitSetDynamicTableCapacity emits for current capacity", () => {
        const enc = new QpackEncoder();
        enc.setEncoderCapacity(64);
        const bytes = enc.emitSetDynamicTableCapacity();
        expect(Array.from(bytes)).toEqual([0x3f, 33]);
    });
});

describe("QPACK dynamic table — eviction respects capacity", () => {
    it("evicts oldest when inserting past capacity", () => {
        const table = new QpackDynamicTable(128);
        table.insert("a", "1");
        table.insert("b", "2");
        table.insert("c", "3");
        expect(table.length).toBe(3);
        table.insert("d", "4");
        expect(table.insertCount).toBe(4);
        expect(table.size).toBeLessThanOrEqual(128);
    });

    it("setCapacity to smaller evicts to fit", () => {
        const table = new QpackDynamicTable(256);
        table.insert("a", "1");
        table.insert("b", "2");
        table.insert("c", "3");
        table.setCapacity(80);
        expect(table.size).toBeLessThanOrEqual(80);
    });

    it("setCapacity to zero evicts everything", () => {
        const table = new QpackDynamicTable(256);
        table.insert("a", "1");
        table.insert("b", "2");
        table.setCapacity(0);
        expect(table.length).toBe(0);
    });
});

describe("QPACK dynamic table — constructor applies initial capacity", () => {
    it("constructs without throwing", () => {
        const quic = new FakeQuic();
        const conn = new Http3ConnectionImpl("test_id", {
            quic: quic.client,
            initialSettings: { [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 512 },
        });
        expect(conn.id).toBe("test_id");
        expect(conn.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(512);
    });
});
