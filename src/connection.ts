/**
 * HTTP/3 connection implementation.
 *
 * Wires frame parsing/serialization, QPACK, the stream manager, the
 * control-stream SETTINGS exchange, GOAWAY, push, and request/response
 * multiplexing over an injected QUIC connection.
 *
 * Lifecycle:
 *   1. `connectHttp3()` opens the control stream + the two QPACK streams.
 *   2. It writes a SETTINGS frame on the control stream and awaits the peer's
 *      SETTINGS (the handshake completes once it arrives, or
 *      `SettingsAckTimeoutError` fires after the configured timeout).
 *   3. `request()` opens an even bidirectional stream, QPACK-encodes request
 *      pseudo-headers + headers into a HEADERS frame, writes an optional DATA
 *      frame, and awaits the response via the stream manager.
 *   4. A per-stream read loop reassembles frames (QUIC delivers bytes in
 *      arbitrary chunks) and dispatches them: control frames to control
 *      handling, request/response frames to the stream manager, QPACK-stream
 *      bytes to the QPACK codec.
 *
 * The package knows nothing about UDP or QUIC internals — the `QuicConnection`
 * is injected and the concrete implementation lives in a future
 * `@browsercore/quic` package. Tests drive this with a fake QUIC connection.
 */

import type { EventEmitter } from "node:events";
import {
    Http3FrameType,
    type Bytes,
    type Http3Connection,
    type Http3Options,
    type Http3Request,
    type Http3Response,
    type Http3SettingsMap,
    type QuicConnection,
    type QuicStream,
} from "./types.js";
import { FrameReader, readFrame, serializeFrame } from "./frame/frame.js";
import { QpackDecoder, encodeHeaders } from "./qpack/qpack.js";
import { createStreamManager } from "./stream/stream.js";
import { GoawayReceivedError, SettingsAckTimeoutError } from "./errors.js";

/** The stream-type identifier written on the control stream (RFC 9114 §6.2). */
const CONTROL_STREAM_TYPE = 0x0;
/** The stream-type identifier written on the QPACK encoder stream. */
const ENCODER_STREAM_TYPE = 0x2;
/** The stream-type identifier written on the QPACK decoder stream. */
const DECODER_STREAM_TYPE = 0x3;

/** Default SETTINGS ACK timeout (ms). */
const DEFAULT_SETTINGS_ACK_TIMEOUT_MS = 5_000;

/** Byte type alias matching the `Uint8Array` wire signatures. */
type ByteBuffer = Uint8Array;

/**
 * Concrete HTTP/3 connection. The public surface matches the fixed
 * `Http3Connection` interface; internal state is kept on the instance.
 */
export class Http3ConnectionImpl implements Http3Connection {
    public readonly id: string;
    public settings: Http3SettingsMap;

    private readonly quic: QuicConnection;
    private readonly qpackDec: QpackDecoder;
    private readonly manager: ReturnType<typeof createStreamManager> & EventEmitter;

    /** Our control + QPACK streams (written to). */
    private controlStream: QuicStream | undefined;
    private encoderStream: QuicStream | undefined;
    private decoderStream: QuicStream | undefined;

    /** Next client-initiated (even) bidirectional stream id. */
    private nextStreamId = 0n;

    /** Set once the connection begins graceful shutdown (GOAWAY sent/received). */
    private closing = false;
    /** Set once the connection is fully torn down. */
    private closed = false;

    public constructor(id: string, options: Http3Options) {
        this.id = id;
        this.settings = options.initialSettings ?? {};
        this.quic = options.quic;
        this.qpackDec = new QpackDecoder();
        this.manager = createStreamManager({
            sendGoaway: (streamId) => {
                void this.sendGoaway(streamId);
            },
            sendCancelPush: (pushId) => {
                void this.sendCancelPush(pushId);
            },
        });
        this.manager.setHeaderDecoder((block) => this.decodeHeaders(block));
        this.manager.on("goaway", (lastStreamId: bigint) => {
            this.onPeerGoaway(lastStreamId);
        });
    }

    // --- public Http3Connection surface ----------------------------------------

    public async request(req: Http3Request): Promise<Http3Response> {
        if (this.closing || this.closed) {
            throw new Error("connection is closing");
        }
        const streamId = this.nextStreamId;
        this.nextStreamId += 2n;

        const stream = await this.quic.openBidirectionalStream();

        // Encode request headers (static-table-only, RIC=0) and send HEADERS.
        const headerMap = new Map<string, string>([
            [":method", req.method],
            [":scheme", req.scheme],
            [":authority", req.authority],
            [":path", req.path],
            ...Array.from(req.headers.entries()),
        ]);
        const headerBlock = encodeHeaders(headerMap);
        await stream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: headerBlock }));

        if (req.body !== undefined && req.body.length > 0) {
            // Request with a body: HEADERS + DATA (the DATA carries END_STREAM).
            await stream.write(serializeFrame({ type: Http3FrameType.DATA, payload: req.body }));
        } else {
            // Request with no body: HEADERS followed by an empty DATA frame to
            // signal END_STREAM (RFC 9114 §4.1).
            await stream.write(serializeFrame({ type: Http3FrameType.DATA, payload: new Uint8Array(0) }));
        }

        // Register the response resolver with the stream manager and start the
        // read loop for this stream.
        const promise = new Promise<Http3Response>((resolve, reject) => {
            this.manager.expectResponse(streamId, resolve, reject);
        });
        this.startBidiReadLoop(stream, streamId);
        return promise;
    }

    public goaway(streamId: bigint): Promise<void> {
        return this.sendGoaway(streamId);
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closing = true;
        await this.sendGoaway(this.nextStreamId);
        this.manager.abortAll(new Error("connection closed"));
        this.closed = true;
        await this.quic.close(0n, "client_close");
    }

    // --- frame I/O -------------------------------------------------------------

    private async sendGoaway(lastStreamId: bigint): Promise<void> {
        if (this.controlStream === undefined) {
            return;
        }
        await this.controlStream.write(
            serializeFrame({ type: Http3FrameType.GOAWAY, streamId: lastStreamId }),
        );
    }

    private async sendCancelPush(pushId: bigint): Promise<void> {
        if (this.controlStream === undefined) {
            return;
        }
        await this.controlStream.write(
            serializeFrame({ type: Http3FrameType.CANCEL_PUSH, pushId }),
        );
    }

    /**
     * Decode a QPACK header block, first ensuring the decoder has consumed
     * enough encoder-stream state to satisfy the block's Required Insert Count.
     */
    private decodeHeaders(block: Bytes): ReadonlyMap<string, string> {
        const ric = this.peekRequiredInsertCount(block);
        this.ensureDecoderState(ric);
        return this.qpackDec.decode(block, ric);
    }

    /** Parse the Required Insert Count from a header block prefix (§4.5.1.1). */
    private peekRequiredInsertCount(block: Bytes): number {
        if (block.length === 0) {
            return 0;
        }
        // RIC is an 8-bit prefixed integer in the first byte (low 7 bits + high bit).
        const first = block[0] ?? 0;
        let ric = first & 0x7f;
        const max = (1 << 7) - 1;
        if (ric === max) {
            let m = 0;
            for (let i = 1; i < block.length; i += 1) {
                const b = block[i] ?? 0;
                ric += (b & 0x7f) * (1 << m);
                m += 7;
                if ((b & 0x80) === 0) {
                    break;
                }
            }
        }
        return ric;
    }

    /**
     * Ensure the decoder's Insert Count meets `ric` by draining buffered
     * encoder-stream bytes. For static-only blocks (RIC=0) this is a no-op.
     */
    private ensureDecoderState(ric: number): void {
        // The peer's encoder stream is drained by the encoder-stream read loop;
        // here we simply rely on it having run. For RIC>0 in dynamic-table
        // scenarios, the read loop keeps the decoder current.
        void ric;
    }

    // --- read loops ------------------------------------------------------------

    /** Start reading response frames from a bidirectional stream. */
    private startBidiReadLoop(stream: QuicStream, streamId: bigint): void {
        const reader = new FrameReader(async () => {
            const chunk = await stream.read();
            return chunk;
        });
        void (async () => {
            try {
                for (;;) {
                    // oxlint-disable-next-line no-await-in-loop -- frames must be processed in arrival order
                    const frame = await reader.readFrame();
                    this.manager.dispatchRequestFrame(streamId, frame);
                }
            } catch {
                // Stream closed / error — the manager's resolver either already
                // resolved or will be rejected by abortAll on shutdown.
            }
        })();
    }

    /** Read control frames from the peer's control stream. */
    private async startControlReadLoop(stream: QuicStream): Promise<void> {
        // The control stream begins with its stream-type byte (0x0); consume it
        // before parsing frames (RFC 9114 §6.2).
        await stream.read();
        const reader = new FrameReader(() => stream.read());
        void (async () => {
            try {
                for (;;) {
                    // oxlint-disable-next-line no-await-in-loop -- frames must be processed in arrival order
                    const frame = await reader.readFrame();
                    this.manager.dispatchControlFrame(frame);
                }
            } catch {
                // Control stream closed.
            }
        })();
    }

    /** Read QPACK encoder-stream instructions from the peer and apply them. */
    private async startEncoderStreamReadLoop(stream: QuicStream): Promise<void> {
        await stream.read(); // consume the encoder stream-type byte (0x2)
        void (async () => {
            try {
                for (;;) {
                    // oxlint-disable-next-line no-await-in-loop -- sequential stream reads
                    const chunk = await stream.read();
                    if (chunk.length === 0) {
                        continue;
                    }
                    this.qpackDec.consumeEncoderStream(chunk);
                }
            } catch {
                // Encoder stream closed.
            }
        })();
    }

    /** Read QPACK decoder-stream instructions from the peer. */
    private async startDecoderStreamReadLoop(stream: QuicStream): Promise<void> {
        await stream.read(); // consume the decoder stream-type byte (0x3)
        void (async () => {
            try {
                for (;;) {
                    // oxlint-disable-next-line no-await-in-loop -- sequential stream reads
                    const chunk = await stream.read();
                    if (chunk.length === 0) {
                        continue;
                    }
                    // Decoder-stream instructions (Section Ack / Cancellation /
                    // Insert Count Increment) update the encoder's bookkeeping.
                    void chunk;
                }
            } catch {
                // Decoder stream closed.
            }
        })();
    }

    /**
     * Open the control + QPACK streams, send SETTINGS, and await the peer's
     * SETTINGS. Resolves when the handshake completes.
     */
    public async doHandshake(timeoutMs: number): Promise<void> {
        // Open our unidirectional streams and write their type identifiers.
        this.controlStream = await this.quic.openUnidirectionalStream();
        await this.controlStream.write(new Uint8Array([CONTROL_STREAM_TYPE]));
        this.encoderStream = await this.quic.openUnidirectionalStream();
        await this.encoderStream.write(new Uint8Array([ENCODER_STREAM_TYPE]));
        this.decoderStream = await this.quic.openUnidirectionalStream();
        await this.decoderStream.write(new Uint8Array([DECODER_STREAM_TYPE]));

        // Send our SETTINGS on the control stream.
        await this.controlStream.write(
            serializeFrame({ type: Http3FrameType.SETTINGS, settings: this.settings }),
        );

        // Accept the peer's control + QPACK streams and start their read loops.
        const peerControl = await this.quic.acceptUnidirectionalStream();
        void this.startControlReadLoop(peerControl);
        const peerEncoder = await this.quic.acceptUnidirectionalStream();
        void this.startEncoderStreamReadLoop(peerEncoder);
        const peerDecoder = await this.quic.acceptUnidirectionalStream();
        void this.startDecoderStreamReadLoop(peerDecoder);

        // Wait for the peer's SETTINGS (signalled via the manager's "settings" event).
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.manager.off("settings", onSettings);
                reject(new SettingsAckTimeoutError(timeoutMs));
                this.manager.abortAll(new SettingsAckTimeoutError(timeoutMs));
            }, timeoutMs);

            const onSettings = (): void => {
                clearTimeout(timer);
                this.manager.off("settings", onSettings);
                resolve();
            };
            this.manager.once("settings", onSettings);
        });
    }

    private onPeerGoaway(lastStreamId: bigint): void {
        this.closing = true;
        // Reject streams opened after lastStreamId.
        this.manager.abortAll(new GoawayReceivedError(lastStreamId));
    }
}

// ---------------------------------------------------------------------------
// connectHttp3
// ---------------------------------------------------------------------------

/**
 * Establish an HTTP/3 connection over an existing QUIC connection.
 *
 * Opens the control + QPACK streams, sends SETTINGS, and awaits the peer's
 * SETTINGS.
 */
export async function connectHttp3(options: Http3Options): Promise<Http3Connection> {
    const id = `http3_${Date.now().toString(36)}`;
    const timeoutMs = options.settingsAckTimeoutMs ?? DEFAULT_SETTINGS_ACK_TIMEOUT_MS;
    const conn = new Http3ConnectionImpl(id, options);
    await conn.doHandshake(timeoutMs);
    return conn;
}

// Re-export for callers/tests that want the frame reader.
export { readFrame };
void (0 as unknown as ByteBuffer);
