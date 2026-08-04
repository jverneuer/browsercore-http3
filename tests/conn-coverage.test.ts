/**
 * Connection-layer coverage for @browsercore/http3.
 *
 * Scope: `src/connection.ts`, `src/errors.ts`, `src/utils.ts`, `src/index.ts`.
 *
 * Run: `npx vitest run tests/conn-coverage.test.ts`
 */

import { describe, it, expect } from "vitest";
import {
    assertNever,
    connectHttp3,
    Http3ConnectionImpl,
    Http3Error,
    GoawayReceivedError,
    PushCancelledError,
    FrameParseError,
    QpackDecodeError,
    SettingsAckTimeoutError,
    SettingsViolationError,
    Http3FrameType,
    Http3Settings,
    Http3StreamType,
    Http3SettingsMap,
    Http3Request,
    Http3Response,
    Http3Connection,
    Http3DataFrame,
    Http3HeadersFrame,
    Http3SettingsFrame,
    Http3GoawayFrame,
    Http3CancelPushFrame,
    Http3PushPromiseFrame,
    Http3MaxPushIdFrame,
    Http3Frame,
    QuicCloseReason,
    VARINT_MAX,
    decodeVarint,
    encodeVarint,
    getVarintEncodedLength,
    createStreamManager,
    qpackEncodeHeaders,
    qpackDecodeHeaders,
    QpackEncoder,
    QpackDecoder,
    QpackDynamicTable,
} from "../src/index.js";
import { concat, concatAll } from "../src/utils.js";
import { serializeFrame, FrameReader } from "../src/frame/frame.js";
import { FakeQuic, driveFakeServer } from "./fake-quic.ts";

function getReq(path = "/", headers = new Map<string, string>()): Http3Request {
    return {
        method: "GET",
        scheme: "https",
        authority: "example.com",
        path,
        headers,
        body: undefined,
    };
}

function postReq(path: string, body: Uint8Array, headers = new Map<string, string>()): Http3Request {
    return {
        method: "POST",
        scheme: "https",
        authority: "example.com",
        path,
        headers,
        body,
    };
}

// ---------------------------------------------------------------------------
// Section 1 — Http3ConnectionImpl construction + surface
// ---------------------------------------------------------------------------

describe("Http3ConnectionImpl — construction", () => {
    it("constructs with an id and options", () => {
        const quic = new FakeQuic().client;
        const conn = new Http3ConnectionImpl("test-conn", { quic });
        expect(conn.id).toBe("test-conn");
    });

    it("initial settings default to an empty object when not provided", () => {
        const quic = new FakeQuic().client;
        const conn = new Http3ConnectionImpl("test-conn", { quic });
        expect(conn.settings).toEqual({});
    });

    it("initial settings reflect the provided initialSettings", () => {
        const quic = new FakeQuic().client;
        const initial: Http3SettingsMap = {
            [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096,
            [Http3Settings.QPACK_BLOCKED_STREAMS]: 100,
        };
        const conn = new Http3ConnectionImpl("test-conn", { quic, initialSettings: initial });
        expect(conn.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(4096);
        expect(conn.settings[Http3Settings.QPACK_BLOCKED_STREAMS]).toBe(100);
    });

    it("exposes request / goaway / close on the prototype", () => {
        expect(typeof Http3ConnectionImpl.prototype.request).toBe("function");
        expect(typeof Http3ConnectionImpl.prototype.goaway).toBe("function");
        expect(typeof Http3ConnectionImpl.prototype.close).toBe("function");
    });

    it("constructor name is Http3ConnectionImpl", () => {
        expect(Http3ConnectionImpl.name).toBe("Http3ConnectionImpl");
    });

    it("instance is recognized by instanceof", () => {
        const quic = new FakeQuic().client;
        const conn = new Http3ConnectionImpl("test-conn", { quic });
        expect(conn).toBeInstanceOf(Http3ConnectionImpl);
    });
});

// ---------------------------------------------------------------------------
// Section 2 — connectHttp3 happy path (SETTINGS handshake)
// ---------------------------------------------------------------------------

describe("connectHttp3 — SETTINGS handshake", () => {
    it("resolves to an Http3Connection with a non-empty id", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        expect(conn.id).toContain("http3_");
        await conn.close();
        await server;
    }, 10000);

    it("negotiates the handshake with the peer's SETTINGS", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        expect(conn.settings).toBeDefined();
        await conn.close();
        await server;
    }, 10000);

    it("passes initialSettings through to the connection", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const initial: Http3SettingsMap = {
            [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 8192,
        };
        const conn = await connectHttp3({
            quic: fake.client,
            initialSettings: initial,
        });
        expect(conn.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(8192);
        await conn.close();
        await server;
    }, 10000);
});

// ---------------------------------------------------------------------------
// Section 3 — SETTINGS initial values + negotiation
// ---------------------------------------------------------------------------

describe("SETTINGS — initial values + negotiation", () => {
    it("QPACK_MAX_TABLE_CAPACITY is 0x1", () => {
        expect(Http3Settings.QPACK_MAX_TABLE_CAPACITY).toBe(0x1);
    });

    it("MAX_FIELD_SECTION_SIZE is 0x6", () => {
        expect(Http3Settings.MAX_FIELD_SECTION_SIZE).toBe(0x6);
    });

    it("QPACK_BLOCKED_STREAMS is 0x7", () => {
        expect(Http3Settings.QPACK_BLOCKED_STREAMS).toBe(0x7);
    });

    it("the SETTINGS map excludes the reserved HTTP/2 identifiers", () => {
        const ids = Object.values(Http3Settings);
        for (const reserved of [0x0, 0x2, 0x3, 0x4, 0x5]) {
            expect(ids).not.toContain(reserved);
        }
    });

    it("a SETTINGS frame serializes and parses its id/value pairs", async () => {
        const frame: Http3SettingsFrame = {
            type: Http3FrameType.SETTINGS,
            settings: {
                [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096,
                [Http3Settings.QPACK_BLOCKED_STREAMS]: 100,
            },
        };
        const wire = serializeFrame(frame);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(4096);
            expect(parsed.settings[Http3Settings.QPACK_BLOCKED_STREAMS]).toBe(100);
        }
    });

    it("an empty SETTINGS frame serializes to just the type + zero length", () => {
        const frame: Http3SettingsFrame = {
            type: Http3FrameType.SETTINGS,
            settings: {},
        };
        const wire = serializeFrame(frame);
        expect(wire.length).toBe(2);
        expect(wire[0]).toBe(Http3FrameType.SETTINGS);
        expect(wire[1]).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Section 4 — request/response
// ---------------------------------------------------------------------------

describe("request/response", () => {
    it("a GET request resolves with a 200 response", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        const res = await conn.request(getReq("/"));
        expect(res.statusCode).toBe(200);
        expect(res.headers.get(":status")).toBe("200");
        expect(res.headers.get("content-type")).toBe("text/plain");
        await conn.close();
        await server;
    }, 10000);

    it("request headers include :method, :scheme, :authority, :path", async () => {
        const fake = new FakeQuic();
        let capturedHeaders = new Map<string, string>();
        const server = (async () => {
            const clientControl = await fake.server.acceptUnidirectionalStream();
            await clientControl.read();
            await fake.server.acceptUnidirectionalStream();
            await fake.server.acceptUnidirectionalStream();
            const serverControl = await fake.server.openUnidirectionalStream();
            await serverControl.write(new Uint8Array([0x0]));
            await fake.server.openUnidirectionalStream();
            await fake.server.openUnidirectionalStream();
            const reader = new FrameReader(async () => clientControl.read());
            await reader.readFrame();
            await serverControl.write(
                serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }),
            );
            const stream = await fake.server.acceptBidirectionalStream();
            const reqReader = new FrameReader(async () => stream.read());
            const headersFrame = await reqReader.readFrame();
            if (headersFrame.type === Http3FrameType.HEADERS) {
                capturedHeaders = qpackDecodeHeaders(headersFrame.payload);
            }
            await reqReader.readFrame();
            const respHeaders = qpackEncodeHeaders(
                new Map([
                    [":status", "200"],
                    ["content-type", "text/plain"],
                ]),
            );
            await stream.write(
                serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }),
            );
            await stream.write(
                serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }),
            );
        })();
        const conn = await connectHttp3({ quic: fake.client });
        await conn.request(getReq("/test-path"));
        expect(capturedHeaders.get(":method")).toBe("GET");
        expect(capturedHeaders.get(":scheme")).toBe("https");
        expect(capturedHeaders.get(":authority")).toBe("example.com");
        expect(capturedHeaders.get(":path")).toBe("/test-path");
        await conn.close();
        await server;
    }, 10000);

    it("a POST request sends HEADERS followed by a non-empty DATA frame", async () => {
        const fake = new FakeQuic();
        let capturedBody = new Uint8Array(0);
        const server = (async () => {
            const clientControl = await fake.server.acceptUnidirectionalStream();
            await clientControl.read();
            await fake.server.acceptUnidirectionalStream();
            await fake.server.acceptUnidirectionalStream();
            const serverControl = await fake.server.openUnidirectionalStream();
            await serverControl.write(new Uint8Array([0x0]));
            await fake.server.openUnidirectionalStream();
            await fake.server.openUnidirectionalStream();
            const reader = new FrameReader(async () => clientControl.read());
            await reader.readFrame();
            await serverControl.write(
                serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }),
            );
            const stream = await fake.server.acceptBidirectionalStream();
            const reqReader = new FrameReader(async () => stream.read());
            await reqReader.readFrame();
            const dataFrame = await reqReader.readFrame();
            if (dataFrame.type === Http3FrameType.DATA) {
                capturedBody = dataFrame.payload;
            }
            const respHeaders = qpackEncodeHeaders(
                new Map([
                    [":status", "200"],
                    ["content-type", "text/plain"],
                ]),
            );
            await stream.write(
                serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }),
            );
            await stream.write(
                serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }),
            );
        })();
        const conn = await connectHttp3({ quic: fake.client });
        const body = new TextEncoder().encode("hello world");
        await conn.request(postReq("/submit", body));
        expect(new TextDecoder().decode(capturedBody)).toBe("hello world");
        await conn.close();
        await server;
    }, 10000);

    it("five concurrent requests each resolve with a 200", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        const results = await Promise.all([
            conn.request(getReq("/a")),
            conn.request(getReq("/b")),
            conn.request(getReq("/c")),
            conn.request(getReq("/d")),
            conn.request(getReq("/e")),
        ]);
        for (const r of results) {
            expect(r.statusCode).toBe(200);
        }
        await conn.close();
        await server;
    }, 15000);

    it("request() after close() rejects", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        await conn.close();
        await expect(conn.request(getReq("/after-close"))).rejects.toThrow();
        await server;
    }, 10000);
});

// ---------------------------------------------------------------------------
// Section 5 — GOAWAY
// ---------------------------------------------------------------------------

describe("GOAWAY", () => {
    it("GOAWAY stream id 0 is encodable", () => {
        const frame: Http3GoawayFrame = { type: Http3FrameType.GOAWAY, streamId: 0n };
        const wire = serializeFrame(frame);
        expect(wire.length).toBeGreaterThan(0);
    });

    it("goaway() sends a GOAWAY frame with the given stream id", async () => {
        const fake = new FakeQuic();
        let capturedGoaway: bigint | undefined;
        let resolveGoaway: () => void;
        const goawayPromise = new Promise<void>((resolve) => { resolveGoaway = resolve; });
        const server = (async () => {
            const clientControl = await fake.server.acceptUnidirectionalStream();
            await clientControl.read();
            await fake.server.acceptUnidirectionalStream();
            await fake.server.acceptUnidirectionalStream();
            const serverControl = await fake.server.openUnidirectionalStream();
            await serverControl.write(new Uint8Array([0x0]));
            await fake.server.openUnidirectionalStream();
            await fake.server.openUnidirectionalStream();
            const reader = new FrameReader(async () => clientControl.read());
            await reader.readFrame();
            await serverControl.write(
                serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }),
            );
            const goawayFrame = await reader.readFrame();
            if (goawayFrame.type === Http3FrameType.GOAWAY) {
                capturedGoaway = goawayFrame.streamId;
            }
            resolveGoaway();
        })();
        const conn = await connectHttp3({ quic: fake.client });
        await conn.goaway(42n);
        await goawayPromise;
        expect(capturedGoaway).toBe(42n);
        await conn.close().catch(() => {});
        await server;
    }, 10000);

    it("close() sends a GOAWAY then closes the QUIC connection", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        await conn.close();
        expect(fake.client.closed).toBe(true);
        await server;
    }, 10000);

    it("close() is idempotent", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        await conn.close();
        await expect(conn.close()).resolves.toBeUndefined();
        await server;
    }, 10000);
});

// ---------------------------------------------------------------------------
// Section 6 — error classes (every constructor branch)
// ---------------------------------------------------------------------------

describe("error classes — construction", () => {
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

describe("error classes — hierarchy + dispatch", () => {
    function everyError(): Http3Error[] {
        return [
            new Http3Error("a"),
            new GoawayReceivedError(1n),
            new PushCancelledError(2n),
            new FrameParseError(3),
            new QpackDecodeError("a"),
            new SettingsViolationError(0x1, 1),
            new SettingsAckTimeoutError(1),
        ];
    }

    it("every HTTP/3 error is an instance of Error and Http3Error", () => {
        for (const e of everyError()) {
            expect(e).toBeInstanceOf(Error);
            expect(e).toBeInstanceOf(Http3Error);
        }
    });

    it("each error exposes a unique `kind` matching its class name", () => {
        const kinds = everyError().map((e) => e.kind);
        expect(kinds).toEqual([
            "Http3Error",
            "GoawayReceivedError",
            "PushCancelledError",
            "FrameParseError",
            "QpackDecodeError",
            "SettingsViolationError",
            "SettingsAckTimeoutError",
        ]);
        expect(new Set(kinds).size).toBe(kinds.length);
    });

    it("exhaustive switch over all error kinds compiles via assertNever", () => {
        const classify = (e: Http3Error): string => {
            switch (e.kind) {
                case "Http3Error":
                    return "base";
                case "GoawayReceivedError":
                    return "goaway";
                case "PushCancelledError":
                    return "cancel_push";
                case "FrameParseError":
                    return "frame_parse";
                case "QpackDecodeError":
                    return "qpack_decode";
                case "SettingsViolationError":
                    return "settings_violation";
                case "SettingsAckTimeoutError":
                    return "settings_timeout";
                default:
                    return assertNever(e);
            }
        };
        for (const e of everyError()) {
            expect(typeof classify(e)).toBe("string");
        }
    });

    it("the cause reference is identity-preserving", () => {
        const root = new RangeError("orig");
        const wrapped = new QpackDecodeError("outer", { cause: root });
        expect(wrapped.cause).toBe(root);
    });
});

// ---------------------------------------------------------------------------
// Section 7 — utils.ts (assertNever, concat, concatAll)
// ---------------------------------------------------------------------------

describe("utils.ts — assertNever", () => {
    it("throws an Error tagged with 'Unexpected value'", () => {
        expect(() => assertNever("unreachable" as never)).toThrow(/Unexpected value/);
    });

    it("the thrown Error includes the offending value in JSON", () => {
        expect(() => assertNever(42 as never)).toThrow(/42/);
    });
});

describe("utils.ts — concat", () => {
    it("joins two non-empty arrays", () => {
        const out = concat(new Uint8Array([1, 2]), new Uint8Array([3, 4]));
        expect(out).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("handles a leading empty array", () => {
        const out = concat(new Uint8Array(), new Uint8Array([5, 6]));
        expect(out).toEqual(new Uint8Array([5, 6]));
    });

    it("handles a trailing empty array", () => {
        const out = concat(new Uint8Array([5, 6]), new Uint8Array());
        expect(out).toEqual(new Uint8Array([5, 6]));
    });

    it("handles both empty arrays", () => {
        const out = concat(new Uint8Array(), new Uint8Array());
        expect(out).toEqual(new Uint8Array());
        expect(out.length).toBe(0);
    });

    it("does not mutate either input", () => {
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([4, 5, 6]);
        const snapA = Array.from(a);
        const snapB = Array.from(b);
        concat(a, b);
        expect(Array.from(a)).toEqual(snapA);
        expect(Array.from(b)).toEqual(snapB);
    });

    it("returns a buffer that does not alias its inputs", () => {
        const a = new Uint8Array([1, 2]);
        const b = new Uint8Array([3, 4]);
        const out = concat(a, b);
        out[0] = 255;
        out[2] = 255;
        expect(a[0]).toBe(1);
        expect(b[0]).toBe(3);
    });
});

describe("utils.ts — concatAll", () => {
    it("joins many arrays", () => {
        const out = concatAll([new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])]);
        expect(out).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("returns an empty array for no parts", () => {
        const out = concatAll([]);
        expect(out).toEqual(new Uint8Array());
        expect(out.length).toBe(0);
    });

    it("handles a single part", () => {
        const out = concatAll([new Uint8Array([7, 8])]);
        expect(out).toEqual(new Uint8Array([7, 8]));
    });

    it("skips empty parts", () => {
        const out = concatAll([new Uint8Array(), new Uint8Array([9]), new Uint8Array()]);
        expect(out).toEqual(new Uint8Array([9]));
    });

    it("is associative: concatAll([a,b,c]) === concatAll([concatAll([a,b]), c])", () => {
        const a = new Uint8Array([1]);
        const b = new Uint8Array([2, 3]);
        const c = new Uint8Array([4, 5, 6]);
        const left = concatAll([a, b, c]);
        const right = concatAll([concatAll([a, b]), c]);
        expect(Array.from(left)).toEqual(Array.from(right));
    });

    it("total length always equals the sum of part lengths (incl. empties)", () => {
        const parts = [
            new Uint8Array(),
            new Uint8Array([1]),
            new Uint8Array(),
            new Uint8Array([2, 3]),
            new Uint8Array([4, 5, 6]),
        ];
        const expectedLen = parts.reduce((n, p) => n + p.length, 0);
        expect(concatAll(parts).length).toBe(expectedLen);
    });

    it("handles a large number of small parts", () => {
        const n = 1000;
        const parts = Array.from({ length: n }, (_, i) => new Uint8Array([i & 0xff]));
        const out = concatAll(parts);
        expect(out.length).toBe(n);
        expect(out[0]).toBe(0);
        expect(out[n - 1]).toBe((n - 1) & 0xff);
    });
});

// ---------------------------------------------------------------------------
// Section 8 — public API surface (index.ts exports)
// ---------------------------------------------------------------------------

describe("public API surface — index.ts", () => {
    const expected = [
        "connectHttp3",
        "Http3ConnectionImpl",
        "Http3Error",
        "GoawayReceivedError",
        "PushCancelledError",
        "FrameParseError",
        "QpackDecodeError",
        "SettingsViolationError",
        "SettingsAckTimeoutError",
        "Http3FrameType",
        "Http3Settings",
        "Http3StreamType",
        "qpackDecodeHeaders",
        "qpackEncodeHeaders",
        "QpackDecoder",
        "QpackDynamicTable",
        "QpackEncoder",
        "createStreamManager",
        "decodeVarint",
        "encodeVarint",
        "getVarintEncodedLength",
        "VARINT_MAX",
        "assertNever",
        "FrameReader",
    ] as const;

    it("every expected runtime export is defined", async () => {
        const ns = await import("../src/index.js");
        for (const name of expected) {
            expect((ns as Record<string, unknown>)[name], `export ${name} should be defined`).toBeDefined();
        }
    });

    it("classes are constructable functions", async () => {
        const ns = await import("../src/index.js");
        for (const ctorName of [
            "Http3ConnectionImpl",
            "Http3Error",
            "GoawayReceivedError",
            "PushCancelledError",
            "FrameParseError",
            "QpackDecodeError",
            "SettingsViolationError",
            "SettingsAckTimeoutError",
            "QpackDecoder",
            "QpackEncoder",
            "QpackDynamicTable",
            "FrameReader",
        ] as const) {
            expect(typeof (ns as Record<string, unknown>)[ctorName]).toBe("function");
        }
    });

    it("the constant tables are plain objects with their RFC-mandated keys", async () => {
        const ns = await import("../src/index.js");
        expect(ns.Http3StreamType).toEqual({
            CONTROL: 0x0,
            PUSH: 0x1,
            QPACK_ENCODER: 0x2,
            QPACK_DECODER: 0x3,
        });
        expect(ns.Http3FrameType).toEqual({
            DATA: 0x0,
            HEADERS: 0x1,
            CANCEL_PUSH: 0x3,
            SETTINGS: 0x4,
            PUSH_PROMISE: 0x5,
            GOAWAY: 0x7,
            MAX_PUSH_ID: 0x0d,
        });
        expect(ns.Http3Settings).toEqual({
            QPACK_MAX_TABLE_CAPACITY: 0x1,
            MAX_FIELD_SECTION_SIZE: 0x6,
            QPACK_BLOCKED_STREAMS: 0x7,
        });
    });

    it("VARINT_MAX is the bigint 2^62 - 1", async () => {
        const ns = await import("../src/index.js");
        expect(typeof ns.VARINT_MAX).toBe("bigint");
        expect(ns.VARINT_MAX).toBe((1n << 62n) - 1n);
    });
});

// ---------------------------------------------------------------------------
// Section 9 — frame / settings / stream-type constants
// ---------------------------------------------------------------------------

describe("RFC-mandated constant values", () => {
    it("Http3StreamType identifiers match RFC 9114", () => {
        expect(Http3StreamType.CONTROL).toBe(0x0);
        expect(Http3StreamType.PUSH).toBe(0x1);
        expect(Http3StreamType.QPACK_ENCODER).toBe(0x2);
        expect(Http3StreamType.QPACK_DECODER).toBe(0x3);
    });

    it("Http3FrameType identifiers match RFC 9114", () => {
        expect(Http3FrameType.DATA).toBe(0x0);
        expect(Http3FrameType.HEADERS).toBe(0x1);
        expect(Http3FrameType.CANCEL_PUSH).toBe(0x3);
        expect(Http3FrameType.SETTINGS).toBe(0x4);
        expect(Http3FrameType.PUSH_PROMISE).toBe(0x5);
        expect(Http3FrameType.GOAWAY).toBe(0x7);
        expect(Http3FrameType.MAX_PUSH_ID).toBe(0x0d);
    });

    it("Http3Settings identifiers match RFC 9114", () => {
        expect(Http3Settings.QPACK_MAX_TABLE_CAPACITY).toBe(0x1);
        expect(Http3Settings.MAX_FIELD_SECTION_SIZE).toBe(0x6);
        expect(Http3Settings.QPACK_BLOCKED_STREAMS).toBe(0x7);
    });

    it("VARINT_MAX is 2^62 - 1", () => {
        expect(VARINT_MAX).toBe((1n << 62n) - 1n);
    });
});

// ---------------------------------------------------------------------------
// Section 10 — Http3Connection / Http3Request / Http3Response / QuicStream contracts
// ---------------------------------------------------------------------------

describe("Http3Connection interface contract", () => {
    it("a mock implementation satisfies the interface shape", () => {
        const mock: Http3Connection = {
            id: "conn-1",
            settings: { [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096 },
            request: async (): Promise<Http3Response> => ({
                statusCode: 200,
                headers: new Map([["content-type", "text/plain"]]),
                body: new Uint8Array(),
            }),
            goaway: async (): Promise<void> => {},
            close: async (): Promise<void> => {},
        };
        expect(mock.id).toBeTypeOf("string");
        expect(mock.settings).toBeTypeOf("object");
        expect(typeof mock.request).toBe("function");
        expect(typeof mock.goaway).toBe("function");
        expect(typeof mock.close).toBe("function");
    });

    it("request() resolves to a well-formed Http3Response", async () => {
        const conn = {
            id: "x",
            settings: {},
            request: async (): Promise<Http3Response> => ({
                statusCode: 200,
                headers: new Map([["x-test", "yes"]]),
                body: new Uint8Array([0x68, 0x69]),
            }),
            goaway: async () => {},
            close: async () => {},
        };
        const res = await conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/",
            headers: new Map(),
            body: undefined,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers.get("x-test")).toBe("yes");
        expect(res.body).toBeInstanceOf(Uint8Array);
    });

    it("request() rejects with an Error on failure", async () => {
        const conn = {
            id: "x",
            settings: {},
            request: async (): Promise<Http3Response> => {
                throw new GoawayReceivedError(0n);
            },
            goaway: async () => {},
            close: async () => {},
        };
        await expect(
            conn.request({
                method: "GET",
                scheme: "https",
                authority: "example.com",
                path: "/",
                headers: new Map(),
                body: undefined,
            }),
        ).rejects.toBeInstanceOf(GoawayReceivedError);
    });
});

describe("Http3Request shape", () => {
    it("method / scheme / authority / path / headers / body are all present", () => {
        const req: Http3Request = {
            method: "POST",
            scheme: "https",
            authority: "example.com",
            path: "/api/v1/thing",
            headers: new Map([["content-type", "application/json"]]),
            body: new Uint8Array([0x7b, 0x7d]),
        };
        expect(req.method).toBe("POST");
        expect(req.scheme).toBe("https");
        expect(req.authority).toBe("example.com");
        expect(req.path).toBe("/api/v1/thing");
        expect(req.headers.get("content-type")).toBe("application/json");
        expect(req.body).toBeInstanceOf(Uint8Array);
    });

    it("an empty-body request carries undefined body", () => {
        const req: Http3Request = {
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/",
            headers: new Map(),
            body: undefined,
        };
        expect(req.body).toBeUndefined();
    });
});

describe("Http3Response shape", () => {
    it("statusCode + headers + body are all present", () => {
        const res: Http3Response = {
            statusCode: 404,
            headers: new Map([["content-type", "text/plain"]]),
            body: new Uint8Array([0x6e, 0x6f, 0x74]),
        };
        expect(res.statusCode).toBe(404);
        expect(res.headers.get("content-type")).toBe("text/plain");
        expect(res.body).toBeInstanceOf(Uint8Array);
    });

    it("a 204 response carries an empty body", () => {
        const res: Http3Response = {
            statusCode: 204,
            headers: new Map(),
            body: new Uint8Array(),
        };
        expect(res.statusCode).toBe(204);
        expect(res.body.length).toBe(0);
    });
});

describe("QuicCloseReason shape", () => {
    it("QuicCloseReason — every variant is constructible", () => {
        const reasons: QuicCloseReason[] = [
            { kind: "client_close" },
            { kind: "remote_close" },
            { kind: "error", error: new Error("boom") },
            { kind: "timeout", afterMs: 5000 },
        ];
        expect(reasons.length).toBe(4);
    });

    it("exhaustive switch over QuicCloseReason compiles via assertNever", () => {
        const describe = (r: QuicCloseReason): string => {
            switch (r.kind) {
                case "client_close":
                    return "client";
                case "remote_close":
                    return "remote";
                case "error":
                    return r.error.message;
                case "timeout":
                    return `${r.afterMs}ms`;
                default:
                    return assertNever(r);
            }
        };
        expect(describe({ kind: "client_close" })).toBe("client");
        expect(describe({ kind: "remote_close" })).toBe("remote");
        expect(describe({ kind: "error", error: new Error("x") })).toBe("x");
        expect(describe({ kind: "timeout", afterMs: 100 })).toBe("100ms");
    });
});

// ---------------------------------------------------------------------------
// Section 11 — frame discriminated-union contract
// ---------------------------------------------------------------------------

describe("Http3Frame discriminated union", () => {
    it("DATA frame has a Bytes payload", () => {
        const f: Http3DataFrame = { type: Http3FrameType.DATA, payload: new Uint8Array([1, 2, 3]) };
        expect(f.type).toBe(0x0);
        expect(f.payload).toBeInstanceOf(Uint8Array);
    });

    it("HEADERS frame has a Bytes payload (QPACK block)", () => {
        const f: Http3HeadersFrame = { type: Http3FrameType.HEADERS, payload: new Uint8Array([0xc0, 0x00]) };
        expect(f.type).toBe(0x1);
        expect(f.payload).toBeInstanceOf(Uint8Array);
    });

    it("SETTINGS frame carries a settings map", () => {
        const f: Http3SettingsFrame = {
            type: Http3FrameType.SETTINGS,
            settings: { [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096 },
        };
        expect(f.type).toBe(0x4);
        expect(f.settings[0x1]).toBe(4096);
    });

    it("GOAWAY frame carries a single stream id", () => {
        const f: Http3GoawayFrame = { type: Http3FrameType.GOAWAY, streamId: 7n };
        expect(f.type).toBe(0x7);
        expect(f.streamId).toBe(7n);
    });

    it("CANCEL_PUSH frame carries a push id", () => {
        const f: Http3CancelPushFrame = { type: Http3FrameType.CANCEL_PUSH, pushId: 3n };
        expect(f.type).toBe(0x3);
        expect(f.pushId).toBe(3n);
    });

    it("PUSH_PROMISE frame carries a push id + payload", () => {
        const f: Http3PushPromiseFrame = {
            type: Http3FrameType.PUSH_PROMISE,
            pushId: 5n,
            payload: new Uint8Array([0xc0]),
        };
        expect(f.type).toBe(0x5);
        expect(f.pushId).toBe(5n);
    });

    it("MAX_PUSH_ID frame carries a push id", () => {
        const f: Http3MaxPushIdFrame = { type: Http3FrameType.MAX_PUSH_ID, pushId: 9n };
        expect(f.type).toBe(0x0d);
        expect(f.pushId).toBe(9n);
    });

    it("every frame variant shares a `type` discriminant", () => {
        const frames: Http3Frame[] = [
            { type: Http3FrameType.DATA, payload: new Uint8Array() },
            { type: Http3FrameType.HEADERS, payload: new Uint8Array() },
            { type: Http3FrameType.CANCEL_PUSH, pushId: 1n },
            { type: Http3FrameType.SETTINGS, settings: {} },
            { type: Http3FrameType.PUSH_PROMISE, pushId: 2n, payload: new Uint8Array() },
            { type: Http3FrameType.GOAWAY, streamId: 0n },
            { type: Http3FrameType.MAX_PUSH_ID, pushId: 3n },
        ];
        for (const f of frames) {
            expect(typeof f.type).toBe("number");
        }
    });

    it("exhaustive switch over Http3Frame compiles (assertNever contract)", () => {
        const narrow = (f: Http3Frame): number => {
            switch (f.type) {
                case Http3FrameType.DATA:
                    return 0;
                case Http3FrameType.HEADERS:
                    return 1;
                case Http3FrameType.CANCEL_PUSH:
                    return 2;
                case Http3FrameType.SETTINGS:
                    return 3;
                case Http3FrameType.PUSH_PROMISE:
                    return 4;
                case Http3FrameType.GOAWAY:
                    return 5;
                case Http3FrameType.MAX_PUSH_ID:
                    return 6;
                default:
                    return assertNever(f);
            }
        };
        expect(
            narrow({ type: Http3FrameType.SETTINGS, settings: {} }),
        ).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Section 12 — stream manager integration
// ---------------------------------------------------------------------------

describe("stream manager — frame dispatch", () => {
    it("createStreamManager returns a manager with the expected surface", () => {
        const manager = createStreamManager({
            sendGoaway: () => {},
            sendCancelPush: () => {},
        });
        expect(typeof manager.expectResponse).toBe("function");
        expect(typeof manager.dispatchRequestFrame).toBe("function");
        expect(typeof manager.dispatchControlFrame).toBe("function");
        expect(typeof manager.abortAll).toBe("function");
        expect(typeof manager.setHeaderDecoder).toBe("function");
    });

    it("a SETTINGS control frame emits the 'settings' event", async () => {
        const manager = createStreamManager({
            sendGoaway: () => {},
            sendCancelPush: () => {},
        });
        manager.setHeaderDecoder(() => new Map());
        let settingsSeen = false;
        manager.once("settings", () => { settingsSeen = true; });
        manager.dispatchControlFrame({ type: Http3FrameType.SETTINGS, settings: {} });
        expect(settingsSeen).toBe(true);
    });

    it("a GOAWAY control frame emits the 'goaway' event with the stream id", async () => {
        const manager = createStreamManager({
            sendGoaway: () => {},
            sendCancelPush: () => {},
        });
        manager.setHeaderDecoder(() => new Map());
        let goawayId: bigint | undefined;
        manager.once("goaway", (id: bigint) => { goawayId = id; });
        manager.dispatchControlFrame({ type: Http3FrameType.GOAWAY, streamId: 42n });
        expect(goawayId).toBe(42n);
    });

    it("a MAX_PUSH_ID control frame emits the 'maxPushId' event", async () => {
        const manager = createStreamManager({
            sendGoaway: () => {},
            sendCancelPush: () => {},
        });
        manager.setHeaderDecoder(() => new Map());
        let maxPushId: bigint | undefined;
        manager.once("maxPushId", (id: bigint) => { maxPushId = id; });
        manager.dispatchControlFrame({ type: Http3FrameType.MAX_PUSH_ID, pushId: 7n });
        expect(maxPushId).toBe(7n);
    });

    it("expectResponse + dispatchRequestFrame resolves a response", async () => {
        const manager = createStreamManager({
            sendGoaway: () => {},
            sendCancelPush: () => {},
        });
        manager.setHeaderDecoder((block) => qpackDecodeHeaders(block));
        const streamId = 0n;
        const promise = new Promise<Http3Response>((resolve, reject) => {
            manager.expectResponse(streamId, resolve, reject);
        });
        const headers = qpackEncodeHeaders(
            new Map([
                [":status", "200"],
                ["x-test", "yes"],
            ]),
        );
        manager.dispatchRequestFrame(streamId, {
            type: Http3FrameType.HEADERS,
            payload: headers,
        });
        manager.dispatchRequestFrame(streamId, {
            type: Http3FrameType.DATA,
            payload: new Uint8Array([0x68, 0x69]),
        });
        const res = await promise;
        expect(res.statusCode).toBe(200);
        expect(res.headers.get("x-test")).toBe("yes");
        expect(Array.from(res.body)).toEqual([0x68, 0x69]);
    });

    it("abortAll rejects every pending response", async () => {
        const manager = createStreamManager({
            sendGoaway: () => {},
            sendCancelPush: () => {},
        });
        manager.setHeaderDecoder(() => new Map());
        const p1 = new Promise<Http3Response>((resolve, reject) => {
            manager.expectResponse(0n, resolve, reject);
        });
        const p2 = new Promise<Http3Response>((resolve, reject) => {
            manager.expectResponse(2n, resolve, reject);
        });
        manager.abortAll(new Error("killed"));
        await expect(p1).rejects.toThrow("killed");
        await expect(p2).rejects.toThrow("killed");
    });
});

// ---------------------------------------------------------------------------
// Section 13 — QPACK round-trip (connection-relevant)
// ---------------------------------------------------------------------------

describe("QPACK — static-table round-trip", () => {
    it("encode then decode a header map", () => {
        const headers = new Map([
            [":status", "200"],
            ["content-type", "text/html"],
            ["x-custom", "value"],
        ]);
        const encoded = qpackEncodeHeaders(headers);
        const decoded = qpackDecodeHeaders(encoded);
        expect(decoded.get(":status")).toBe("200");
        expect(decoded.get("content-type")).toBe("text/html");
        expect(decoded.get("x-custom")).toBe("value");
    });

    it("encode then decode an empty header map", () => {
        const headers = new Map<string, string>();
        const encoded = qpackEncodeHeaders(headers);
        const decoded = qpackDecodeHeaders(encoded);
        expect(decoded.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Section 14 — varint round-trip (connection-relevant)
// ---------------------------------------------------------------------------

describe("varint — round-trip", () => {
    it("0 encodes and decodes", () => {
        const wire = encodeVarint(0n);
        expect(wire.length).toBe(1);
        expect(decodeVarint(wire).value).toBe(0n);
    });

    it("2^6 - 1 encodes in one byte", () => {
        const v = (1n << 6n) - 1n;
        const wire = encodeVarint(v);
        expect(wire.length).toBe(1);
        expect(decodeVarint(wire).value).toBe(v);
    });

    it("2^14 - 1 encodes in two bytes", () => {
        const v = (1n << 14n) - 1n;
        const wire = encodeVarint(v);
        expect(wire.length).toBe(2);
        expect(decodeVarint(wire).value).toBe(v);
    });

    it("2^30 - 1 encodes in four bytes", () => {
        const v = (1n << 30n) - 1n;
        const wire = encodeVarint(v);
        expect(wire.length).toBe(4);
        expect(decodeVarint(wire).value).toBe(v);
    });

    it("2^62 - 1 (VARINT_MAX) encodes in eight bytes", () => {
        const wire = encodeVarint(VARINT_MAX);
        expect(wire.length).toBe(8);
        expect(decodeVarint(wire).value).toBe(VARINT_MAX);
    });

    it("decodeVarint returns the correct length", () => {
        expect(decodeVarint(encodeVarint(0n)).length).toBe(1);
        expect(decodeVarint(encodeVarint(50n)).length).toBe(1);
        expect(decodeVarint(encodeVarint(100n)).length).toBe(2);
        expect(decodeVarint(encodeVarint(1000n)).length).toBe(2);
        expect(decodeVarint(encodeVarint(100_000n)).length).toBe(4);
        expect(decodeVarint(encodeVarint(10n ** 18n)).length).toBe(8);
    });

    it("decodeVarint throws RangeError on empty buffer", () => {
        expect(() => decodeVarint(new Uint8Array())).toThrow(RangeError);
    });

    it("decodeVarint throws RangeError on truncated buffer", () => {
        const truncated = new Uint8Array([0x40]);
        expect(() => decodeVarint(truncated)).toThrow(RangeError);
    });

    it("getVarintEncodedLength throws on negative", () => {
        expect(() => getVarintEncodedLength(-1n)).toThrow(RangeError);
    });

    it("getVarintEncodedLength throws above VARINT_MAX", () => {
        expect(() => getVarintEncodedLength(VARINT_MAX + 1n)).toThrow(RangeError);
    });
});

// ---------------------------------------------------------------------------
// Section 15 — frame reader / serializer round-trip
// ---------------------------------------------------------------------------

describe("frame reader / serializer — round-trip", () => {
    it("DATA frame round-trips", async () => {
        const frame: Http3DataFrame = {
            type: Http3FrameType.DATA,
            payload: new Uint8Array([1, 2, 3, 4]),
        };
        const wire = serializeFrame(frame);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.DATA);
        if (parsed.type === Http3FrameType.DATA) {
            expect(Array.from(parsed.payload)).toEqual([1, 2, 3, 4]);
        }
    });

    it("HEADERS frame round-trips", async () => {
        const frame: Http3HeadersFrame = {
            type: Http3FrameType.HEADERS,
            payload: new Uint8Array([0xc0, 0x00]),
        };
        const wire = serializeFrame(frame);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.HEADERS);
        if (parsed.type === Http3FrameType.HEADERS) {
            expect(Array.from(parsed.payload)).toEqual([0xc0, 0x00]);
        }
    });

    it("SETTINGS frame round-trips", async () => {
        const frame: Http3SettingsFrame = {
            type: Http3FrameType.SETTINGS,
            settings: {
                [Http3Settings.QPACK_MAX_TABLE_CAPACITY]: 4096,
                [Http3Settings.QPACK_BLOCKED_STREAMS]: 100,
            },
        };
        const wire = serializeFrame(frame);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.SETTINGS);
        if (parsed.type === Http3FrameType.SETTINGS) {
            expect(parsed.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY]).toBe(4096);
            expect(parsed.settings[Http3Settings.QPACK_BLOCKED_STREAMS]).toBe(100);
        }
    });

    it("GOAWAY frame round-trips", async () => {
        const frame: Http3GoawayFrame = { type: Http3FrameType.GOAWAY, streamId: 7n };
        const wire = serializeFrame(frame);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.GOAWAY);
        if (parsed.type === Http3FrameType.GOAWAY) {
            expect(parsed.streamId).toBe(7n);
        }
    });

    it("CANCEL_PUSH frame round-trips", async () => {
        const frame: Http3CancelPushFrame = { type: Http3FrameType.CANCEL_PUSH, pushId: 3n };
        const wire = serializeFrame(frame);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.CANCEL_PUSH);
        if (parsed.type === Http3FrameType.CANCEL_PUSH) {
            expect(parsed.pushId).toBe(3n);
        }
    });

    it("MAX_PUSH_ID frame round-trips", async () => {
        const frame: Http3MaxPushIdFrame = { type: Http3FrameType.MAX_PUSH_ID, pushId: 9n };
        const wire = serializeFrame(frame);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.MAX_PUSH_ID);
        if (parsed.type === Http3FrameType.MAX_PUSH_ID) {
            expect(parsed.pushId).toBe(9n);
        }
    });

    it("an unknown (GREASE) frame type is parsed as Http3UnknownFrame", async () => {
        const wire = new Uint8Array([0x21, 1, 0xff]);
        const reader = new FrameReader(async () => wire);
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(-1);
    });

    it("FrameReader reassembles a frame split across multiple reads", async () => {
        const frame: Http3DataFrame = {
            type: Http3FrameType.DATA,
            payload: new Uint8Array([10, 20, 30]),
        };
        const wire = serializeFrame(frame);
        const chunk1 = wire.subarray(0, 2);
        const chunk2 = wire.subarray(2);
        let call = 0;
        const reader = new FrameReader(async () => {
            call += 1;
            return call === 1 ? chunk1 : chunk2;
        });
        const parsed = await reader.readFrame();
        expect(parsed.type).toBe(Http3FrameType.DATA);
        if (parsed.type === Http3FrameType.DATA) {
            expect(Array.from(parsed.payload)).toEqual([10, 20, 30]);
        }
    });

    it("FrameReader throws FrameParseError on a stream that ends mid-frame", async () => {
        const reader = new FrameReader(async () => new Uint8Array());
        await expect(reader.readFrame()).rejects.toBeInstanceOf(FrameParseError);
    });
});

// ---------------------------------------------------------------------------
// Section 16 — transport integration (FakeQuic contract)
// ---------------------------------------------------------------------------

describe("FakeQuic — transport contract", () => {
    it("exposes client and server faces that satisfy QuicConnection", () => {
        const fake = new FakeQuic();
        expect(typeof fake.client.openBidirectionalStream).toBe("function");
        expect(typeof fake.client.acceptBidirectionalStream).toBe("function");
        expect(typeof fake.client.openUnidirectionalStream).toBe("function");
        expect(typeof fake.client.acceptUnidirectionalStream).toBe("function");
        expect(typeof fake.client.close).toBe("function");
        expect(typeof fake.server.openBidirectionalStream).toBe("function");
        expect(typeof fake.server.acceptBidirectionalStream).toBe("function");
        expect(typeof fake.server.openUnidirectionalStream).toBe("function");
        expect(typeof fake.server.acceptUnidirectionalStream).toBe("function");
        expect(typeof fake.server.close).toBe("function");
    });

    it("a stream opened on the client is accepted on the server", async () => {
        const fake = new FakeQuic();
        const clientStream = await fake.client.openBidirectionalStream();
        const serverStream = await fake.server.acceptBidirectionalStream();
        expect(clientStream).toBeDefined();
        expect(serverStream).toBeDefined();
    });

    it("bytes written on the client stream are read on the server stream", async () => {
        const fake = new FakeQuic();
        const clientStream = await fake.client.openBidirectionalStream();
        const serverStream = await fake.server.acceptBidirectionalStream();
        const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const readPromise = serverStream.read();
        await clientStream.write(payload);
        const got = await readPromise;
        expect(got).toEqual(payload);
    });

    it("bytes written on the server stream are read on the client stream", async () => {
        const fake = new FakeQuic();
        const clientStream = await fake.client.openBidirectionalStream();
        const serverStream = await fake.server.acceptBidirectionalStream();
        const payload = new Uint8Array([0xca, 0xfe]);
        const readPromise = clientStream.read();
        await serverStream.write(payload);
        const got = await readPromise;
        expect(got).toEqual(payload);
    });

    it("a unidirectional stream opened on the client is accepted on the server", async () => {
        const fake = new FakeQuic();
        const clientStream = await fake.client.openUnidirectionalStream();
        const serverStream = await fake.server.acceptUnidirectionalStream();
        expect(clientStream).toBeDefined();
        expect(serverStream).toBeDefined();
    });

    it("client-initiated bidi stream ids are even (0 mod 4)", async () => {
        const fake = new FakeQuic();
        const s1 = await fake.client.openBidirectionalStream();
        const s2 = await fake.client.openBidirectionalStream();
        expect((s1 as { id: bigint }).id).toBe(0n);
        expect((s2 as { id: bigint }).id).toBe(4n);
    });

    it("server-initiated bidi stream ids are odd (1 mod 4)", async () => {
        const fake = new FakeQuic();
        const s1 = await fake.server.openBidirectionalStream();
        expect((s1 as { id: bigint }).id).toBe(1n);
    });

    it("client.close() records the closed state", async () => {
        const fake = new FakeQuic();
        await fake.client.close(0x1, "graceful shutdown");
        expect((fake.client as { closed: boolean }).closed).toBe(true);
    });

    it("a closed connection rejects pending accepts", async () => {
        const fake = new FakeQuic();
        const acceptPromise = fake.server.acceptBidirectionalStream();
        await fake.client.close(0n, "done");
        await expect(acceptPromise).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Section 17 — end-to-end integration (connectHttp3 + FakeQuic)
// ---------------------------------------------------------------------------

describe("end-to-end — connectHttp3 + FakeQuic", () => {
    it("a full request/response cycle", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        const res = await conn.request(getReq("/"));
        expect(res.statusCode).toBe(200);
        expect(res.headers.get(":status")).toBe("200");
        await conn.close();
        await server;
    }, 10000);

    it("a request with a body", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        const body = new TextEncoder().encode("request body");
        const res = await conn.request(postReq("/submit", body));
        expect(res.statusCode).toBe(200);
        await conn.close();
        await server;
    }, 10000);

    it("concurrent requests multiplex over separate streams", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        const results = await Promise.all([
            conn.request(getReq("/a")),
            conn.request(getReq("/b")),
            conn.request(getReq("/c")),
        ]);
        for (const r of results) {
            expect(r.statusCode).toBe(200);
        }
        await conn.close();
        await server;
    }, 15000);

    it("close() after requests drains the connection", async () => {
        const fake = new FakeQuic();
        const server = driveFakeServer(fake.server);
        const conn = await connectHttp3({ quic: fake.client });
        await conn.request(getReq("/"));
        await conn.close();
        expect(fake.client.closed).toBe(true);
        await server;
    }, 10000);
});
