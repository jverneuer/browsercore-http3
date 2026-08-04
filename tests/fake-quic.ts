/**
 * A fake in-process QUIC connection for testing HTTP/3.
 *
 * One `FakeQuic` instance models the whole connection and exposes two faces:
 * `client` and `server` (both satisfy `QuicConnection`). Each QUIC stream is
 * modeled as a paired duplex: writing to one half delivers bytes to the other
 * half's receive buffer (and vice versa) — endpoints never read their own
 * writes, matching real QUIC streams. The server face is driven by a script
 * that completes the handshake and responds to each request with a 200.
 *
 * This is the contract the future `@browsercore/quic` package must satisfy.
 */

import type { Bytes, QuicConnection, QuicStream } from "../src/types.js";
import { FrameReader, serializeFrame } from "../src/frame/frame.js";
import { encodeHeaders } from "../src/qpack/qpack.js";
import { Http3FrameType } from "../src/types.js";

/** One half of a paired duplex byte stream. */
class FakeStream implements QuicStream {
    public readonly id: bigint;
    private readonly inbox: Bytes[] = [];
    private readWaiter: ((data: Bytes) => void) | undefined;
    private closed = false;
    public peer: FakeStream | undefined;

    public constructor(id: bigint) {
        this.id = id;
    }

    /** Write bytes to the stream: they arrive at the peer's end. */
    public async write(data: Bytes): Promise<void> {
        if (this.closed) {
            throw new Error("stream closed");
        }
        const dest = this.peer;
        if (dest === undefined) {
            throw new Error("stream has no peer");
        }
        const waiter = dest.readWaiter;
        dest.readWaiter = undefined;
        if (waiter !== undefined) {
            waiter(data);
        } else {
            dest.inbox.push(data);
        }
    }

    /** Read bytes written by the peer. */
    public read(): Promise<Bytes> {
        const next = this.inbox.shift();
        if (next !== undefined) {
            return Promise.resolve(next);
        }
        if (this.closed) {
            return Promise.resolve(new Uint8Array(0));
        }
        return new Promise((resolve) => {
            this.readWaiter = resolve;
        });
    }

    public async close(): Promise<void> {
        this.closed = true;
        const waiter = this.readWaiter;
        this.readWaiter = undefined;
        if (waiter !== undefined) {
            waiter(new Uint8Array(0));
        }
    }
}

/** A stream opened on one face, awaiting accept on the other. */
interface BufferedStream {
    /** The half of the pair the opener holds; the peer half is buffered. */
    readonly local: FakeStream;
    readonly kind: "bidirectional" | "unidirectional";
}

/**
 * One face (client or server) of the fake QUIC connection. Streams opened
 * here are accepted on the peer face.
 */
class QuicFace implements QuicConnection {
    public readonly id: string;
    private readonly buffered: BufferedStream[] = [];
    private acceptWaiter: ((s: BufferedStream) => void) | undefined;
    private acceptRejecter: ((err: Error) => void) | undefined;
    private nextBidi = 0;
    private nextUni = 0;
    private closed = false;
    public peerRef!: QuicFace;

    public constructor(id: string, isClient: boolean) {
        this.id = id;
        // Client-initiated bidi streams are 0 mod 4; server-initiated are 1 mod 4.
        this.nextBidi = isClient ? 0 : 1;
        this.nextUni = isClient ? 2 : 3;
    }

    private get peer(): QuicFace {
        return this.peerRef;
    }

    private open(kind: "bidirectional" | "unidirectional"): FakeStream {
        const id = kind === "bidirectional" ? this.nextBidi : this.nextUni;
        if (kind === "bidirectional") {
            this.nextBidi += 4;
        } else {
            this.nextUni += 4;
        }
        // Create a paired duplex: local half and peer half.
        const local = new FakeStream(BigInt(id));
        const peerHalf = new FakeStream(BigInt(id));
        local.peer = peerHalf;
        peerHalf.peer = local;
        const buffered: BufferedStream = { local, kind };
        if (this.peer.acceptWaiter !== undefined) {
            const waiter = this.peer.acceptWaiter;
            this.peer.acceptWaiter = undefined;
            waiter(buffered);
        } else {
            this.peer.buffered.push(buffered);
        }
        return local;
    }

    private accept(kind: "bidirectional" | "unidirectional"): Promise<FakeStream> {
        const found = this.buffered.find((s) => s.kind === kind);
        if (found !== undefined) {
            const i = this.buffered.indexOf(found);
            this.buffered.splice(i, 1);
            // Return the PEER half so reads/writes cross over to the opener.
            return Promise.resolve(found.local.peer!);
        }
        if (this.closed) {
            return Promise.reject(new Error("connection closed"));
        }
        return new Promise<FakeStream>((resolve, reject) => {
            this.acceptWaiter = (s) => {
                if (s.kind === kind) {
                    this.acceptWaiter = undefined;
                    resolve(s.local.peer!);
                } else {
                    this.buffered.push(s);
                }
            };
            this.acceptRejecter = reject;
        });
    }

    public openBidirectionalStream(): Promise<QuicStream> {
        return Promise.resolve(this.open("bidirectional"));
    }

    public acceptBidirectionalStream(): Promise<QuicStream> {
        return this.accept("bidirectional");
    }

    public openUnidirectionalStream(): Promise<QuicStream> {
        return Promise.resolve(this.open("unidirectional"));
    }

    public acceptUnidirectionalStream(): Promise<QuicStream> {
        return this.accept("unidirectional");
    }

    public close(errorCode: bigint, reason: string): Promise<void> {
        void errorCode;
        void reason;
        this.closed = true;
        // Reject any pending accept so blocked reads terminate.
        const reject = this.acceptRejecter;
        this.acceptRejecter = undefined;
        this.acceptWaiter = undefined;
        if (reject !== undefined) {
            reject(new Error("connection closed"));
        }
        // A connection-level close terminates both directions: also close the
        // peer face so the remote endpoint's blocked accepts reject.
        if (!this.peer.closed) {
            void this.peer.close(errorCode, reason);
        }
        return Promise.resolve();
    }
}

/** A fake QUIC connection exposing client and server faces. */
export class FakeQuic {
    public readonly client: QuicConnection;
    public readonly server: QuicConnection;

    private readonly clientFace = new QuicFace("client", true);
    private readonly serverFace = new QuicFace("server", false);

    public constructor() {
        this.clientFace.peerRef = this.serverFace;
        this.serverFace.peerRef = this.clientFace;
        this.client = this.clientFace;
        this.server = this.serverFace;
    }
}

/**
 * Drive the server face: complete the handshake and serve a 200 response to
 * every request. Resolves when the control stream closes.
 */
export async function driveFakeServer(server: QuicConnection): Promise<void> {
    // Accept the client's control + QPACK streams.
    const clientControl = await server.acceptUnidirectionalStream();
    await clientControl.read(); // control stream type byte (0x0)
    await server.acceptUnidirectionalStream(); // encoder stream
    await server.acceptUnidirectionalStream(); // decoder stream

    // Open our own control + QPACK streams.
    const serverControl = await server.openUnidirectionalStream();
    await serverControl.write(new Uint8Array([0x0]));
    await server.openUnidirectionalStream(); // encoder stream
    await server.openUnidirectionalStream(); // decoder stream

    // Read the client's SETTINGS, then reply with our own SETTINGS.
    const reader = new FrameReader(async () => clientControl.read());
    await reader.readFrame(); // client SETTINGS
    await serverControl.write(serializeFrame({ type: Http3FrameType.SETTINGS, settings: {} }));

    // Serve request streams until the connection closes.
    for (;;) {
        let stream: QuicStream;
        try {
            stream = await server.acceptBidirectionalStream();
        } catch {
            return;
        }
        void (async () => {
            try {
                // Use a single FrameReader for the whole request.
                const reqReader = new FrameReader(async () => stream.read());
                let f = await reqReader.readFrame();
                while (f.type !== Http3FrameType.HEADERS && f.type !== Http3FrameType.DATA) {
                    f = await reqReader.readFrame();
                }
                for (;;) {
                    const next = await reqReader.readFrame();
                    if (next.type === Http3FrameType.DATA) {
                        break;
                    }
                }
                const respHeaders = encodeHeaders(
                    new Map([
                        [":status", "200"],
                        ["content-type", "text/plain"],
                    ]),
                );
                await stream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: respHeaders }));
                await stream.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
            } catch {
                // stream done
            }
        })();
    }
}
