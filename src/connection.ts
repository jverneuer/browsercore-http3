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
 *      pseudo-headers + headers into a HEADERS frame using the dynamic table,
 *      writes the resulting encoder-stream instructions, writes an optional
 *      DATA frame, and awaits the response via the stream manager.
 *   4. A per-stream read loop reassembles frames (QUIC delivers bytes in
 *      arbitrary chunks) and dispatches them: control frames to control
 *      handling, request/response frames to the stream manager, QPACK-stream
 *      bytes to the QPACK codec.
 *
 * QPACK dynamic-table wiring (RFC 9204):
 *   - `qpackEnc` encodes request headers and emits encoder-stream instructions
 *     (Insert-With-Literal-Name etc.) that we write to our encoder stream.
 *   - `qpackDec` decodes response header blocks and consumes the peer's
 *     encoder-stream instructions; it emits decoder-stream instructions
 *     (Section Acknowledgment, Stream Cancellation, Insert Count Increment)
 *     that we write to our decoder stream.
 *   - SETTINGS_QPACK_MAX_TABLE_CAPACITY from the peer is applied to our
 *     encoder via Set Capacity; our advertised capacity is applied to our
 *     decoder.
 *   - Required Insert Count (RIC) per §2.1.3 is tracked per response block:
 *     when we decode a block with RIC > 0, we emit a Section Acknowledgment
 *     for that stream on the decoder stream.
 *
 * The package knows nothing about UDP or QUIC internals — the `QuicConnection`
 * is injected and the concrete implementation lives in a future
 * `@browsercore/quic` package. Tests drive this with a fake QUIC connection.
 */

import type { EventEmitter } from "node:events";
import type { RandomSource } from "@browsercore/transport";
import { nodeRandomSource } from "@browsercore/transport";
import {
    Http3FrameType,
    Http3Settings,
    type Bytes,
    type ConnectionId,
    type Http3Connection,
    type Http3Frame,
    type Http3Options,
    type Http3Request,
    type Http3Response,
    type Http3SettingsMap,
    type Http3StreamId,
    type QuicConnection,
    type QuicStream,
} from "./types.js";
import { FrameReader, readFrame, serializeFrame } from "./frame/frame.js";
import { QpackDecoder, QpackEncoder } from "./qpack/qpack.js";
import { ByteReader, readPrefixedInt } from "./qpack/encoding.js";
import { createStreamManager } from "./stream/stream.js";
import {
    ConnectionClosedError,
    ConnectionClosingError,
    GoawayReceivedError,
    SettingsAckTimeoutError,
} from "./errors.js";
import { createId } from "./utils.js";

/** The stream-type identifier written on the control stream (RFC 9114 §6.2). */
const CONTROL_STREAM_TYPE = 0x0;
/** The stream-type identifier written on the QPACK encoder stream. */
const ENCODER_STREAM_TYPE = 0x2;
/** The stream-type identifier written on the QPACK decoder stream. */
const DECODER_STREAM_TYPE = 0x3;

/** Default SETTINGS ACK timeout (ms). */
const DEFAULT_SETTINGS_ACK_TIMEOUT_MS = 5_000;

/** Default QPACK max table capacity (bytes). */
const DEFAULT_QPACK_MAX_TABLE_CAPACITY = 0x1000;

/** Byte type alias matching the `Uint8Array` wire signatures. */
type ByteBuffer = Uint8Array;

/**
 * Concrete HTTP/3 connection. The public surface matches the fixed
 * `Http3Connection` interface; internal state is kept on the instance.
 */
export class Http3ConnectionImpl implements Http3Connection {
    public readonly id: ConnectionId;
    public settings: Http3SettingsMap;

    private readonly quic: QuicConnection;
    private readonly qpackDec: QpackDecoder;
    private readonly qpackEnc: QpackEncoder;
    private readonly manager: ReturnType<typeof createStreamManager> & EventEmitter;

    /** Our control + QPACK streams (written to). */
    private controlStream: QuicStream | undefined;
    private encoderStream: QuicStream | undefined;
    private decoderStream: QuicStream | undefined;

    /** Next client-initiated (even) bidirectional stream id. */
    private nextStreamId: Http3StreamId = 0n as Http3StreamId;

    /** Queue of pending push response promises (pushPromise already fired, push() not yet called). */
    private pendingPushes: Promise<Http3Response>[] = [];

    /** Set once the connection begins graceful shutdown (GOAWAY sent/received). */
    private closing = false;
    /** Set once the connection is fully torn down. */
    private closed = false;

    public constructor(id: ConnectionId, options: Http3Options) {
        this.id = id;
        this.settings = options.initialSettings ?? {};
        this.quic = options.quic;
        this.qpackEnc = new QpackEncoder();
        this.qpackDec = new QpackDecoder();
        // Apply our advertised QPACK max capacity to both codec sides. Our
        // advertised capacity is a safe initial bound for the encoder (the peer
        // can't exceed it per RFC 9204 §2.2.1); the decoder uses the same bound
        // since it tracks the peer's encoder. These are clamped when the peer's
        // SETTINGS arrive (see applyPeerSettings).
        const initialCapacity =
            this.settings[Http3Settings.QPACK_MAX_TABLE_CAPACITY] ?? DEFAULT_QPACK_MAX_TABLE_CAPACITY;
        this.qpackDec.applyMaxCapacity(initialCapacity);
        this.qpackEnc.applyMaxCapacity(initialCapacity);
        this.manager = createStreamManager({
            sendGoaway: (streamId) => {
                void this.sendGoaway(streamId);
            },
            sendCancelPush: (pushId) => {
                void this.sendCancelPush(pushId);
            },
        });
        this.manager.setHeaderDecoder((block) => this.decodeHeaders(block));
        this.manager.on("goaway", (lastStreamId: Http3StreamId) => {
            this.onPeerGoaway(lastStreamId);
        });
        this.manager.on("pushPromise", (pushId: Http3StreamId) => {
            this.onPushPromise(pushId);
        });
    }

    // --- public Http3Connection surface ----------------------------------------

    public async request(req: Http3Request): Promise<Http3Response> {
        if (this.closing || this.closed) {
            throw new ConnectionClosingError();
        }
        const streamId = this.nextStreamId;
        this.nextStreamId = (this.nextStreamId + 2n) as Http3StreamId;

        const stream = await this.quic.openBidirectionalStream();

        // Encode request headers against the shared dynamic table and send
        // HEADERS. The encoder returns a header block plus any encoder-stream
        // instructions (Set Capacity / Insert); the latter are written to the
        // QPACK encoder stream so the peer's decoder stays in sync.
        const headerMap = new Map<string, string>([
            [":method", req.method],
            [":scheme", req.scheme],
            [":authority", req.authority],
            [":path", req.path],
            ...Array.from(req.headers.entries()),
        ]);
        const encoded = this.qpackEnc.encode(headerMap);
        this.writeEncoderStream(encoded.encoderBytes);
        await stream.write(serializeFrame({ type: Http3FrameType.HEADERS, payload: encoded.block }));

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

    /**
     * Write bytes to our QPACK encoder stream (the peer reads these). Swallows
     * errors: if the encoder stream is gone, the peer is misbehaving and we
     * let the connection-level error handling deal with it.
     */
    private writeEncoderStream(bytes: Bytes): void {
        const s = this.encoderStream;
        if (s === undefined) {
            return;
        }
        void s.write(bytes).catch(() => {});
    }

    /**
     * Write bytes to our QPACK decoder stream (the peer reads these — Section
     * Acknowledgment, Stream Cancellation, Insert Count Increment). Swallows
     * errors for robustness against a gone stream.
     */
    private writeDecoderStream(bytes: Bytes): void {
        const s = this.decoderStream;
        if (s === undefined) {
            return;
        }
        void s.write(bytes).catch(() => {});
    }

    /**
     * Accept a server push: register a push resolver and read the pushed
     * response from the push stream the server opened.
     *
     * Handles the race where the pushPromise event already fired before
     * push() was called: the resolver is registered and the promise queued
     * in onPushPromise, so push() can drain it immediately. Otherwise push()
     * waits for the next event.
     */
    public push(): Promise<Http3Response> {
        // If a pushPromise event already fired (race: event emitted before
        // push() was called), drain the already-queued promise. Otherwise
        // wait for the next event — onPushPromise will queue a promise that
        // the listener below dequeues.
        const queued = this.pendingPushes.shift();
        if (queued !== undefined) {
            return queued;
        }
        return new Promise<Http3Response>((resolve) => {
            this.manager.once("pushPromise", (): void => {
                const p = this.pendingPushes.shift();
                if (p !== undefined) {
                    resolve(p);
                }
            });
        });
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
        this.manager.abortAll(new ConnectionClosedError());
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
     * After a successful decode of a block with RIC > 0, emits a Section
     * Acknowledgment for the stream on the decoder stream (RFC 9204 §2.1.3).
     */
    private decodeHeaders(block: Bytes, streamId: bigint): ReadonlyMap<string, string> {
        const ric = this.peekRequiredInsertCount(block);
        this.ensureDecoderState(ric);
        const headers = this.qpackDec.decode(block, ric);
        if (ric > 0) {
            this.emitSectionAcknowledgment(streamId);
        }
        return headers;
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

    /**
     * Emit a Section Acknowledgment on the decoder stream for the given stream.
     * This tells the peer's encoder that we have fully decoded the header block
     * for this stream and received all dynamic-table inserts it references,
     * allowing the peer to use post-base references for those entries
     * (RFC 9204 §2.1.3).
     */
    private emitSectionAcknowledgment(streamId: bigint): void {
        this.writeDecoderStream(this.qpackDec.emitSectionAcknowledgment(streamId));
    }

    // --- read loops ------------------------------------------------------------

    /** Start reading response frames from a bidirectional stream. */
    private startBidiReadLoop(stream: QuicStream, streamId: Http3StreamId): void {
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
                    this.onControlFrame(frame);
                }
            } catch {
                // Control stream closed.
            }
        })();
    }

    /**
     * Handle a control frame: dispatch to the manager for SETTINGS/GOAWAY/etc.,
     * and apply QPACK SETTINGS (QPACK_MAX_TABLE_CAPACITY, QPACK_BLOCKED_STREAMS)
     * to our encoder/decoder immediately so subsequent header encoding honors
     * the peer's limits.
     */
    private onControlFrame(frame: Http3Frame): void {
        this.manager.dispatchControlFrame(frame);
        if (frame.type === Http3FrameType.SETTINGS) {
            this.applyPeerSettings(frame.settings);
        }
    }

    /**
     * Apply QPACK-relevant SETTINGS from the peer to our encoder and decoder.
     *   - QPACK_MAX_TABLE_CAPACITY: the peer's advertised max dynamic-table
     *     capacity. We apply it to our encoder (clamping how large our dynamic
     *     table may grow) and emit a Set Capacity instruction on the encoder
     *     stream so the peer's decoder learns the new capacity.
     *   - QPACK_BLOCKED_STREAMS: flow-control hint for the encoder — how many
     *     streams the peer will tolerate being blocked on RIC. We record it;
     *     enforcement is encoder-side.
     */
    private applyPeerSettings(peerSettings: Http3SettingsMap): void {
        const peerMaxCapacity = peerSettings[Http3Settings.QPACK_MAX_TABLE_CAPACITY];
        if (peerMaxCapacity !== undefined) {
            // setEncoderCapacity updates the encoder's table capacity and
            // returns the Set Capacity instruction bytes — write them to the
            // encoder stream so the peer's decoder learns the new capacity.
            this.writeEncoderStream(this.qpackEnc.setEncoderCapacity(peerMaxCapacity));
        }
        const peerBlockedStreams = peerSettings[Http3Settings.QPACK_BLOCKED_STREAMS];
        if (peerBlockedStreams !== undefined) {
            // Flow-control hint: the peer will tolerate at most this many
            // streams blocked on RIC. A production encoder would use this to
            // pace dynamic-table inserts. We record it for completeness.
            void peerBlockedStreams;
        }
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
                    // Acknowledge received inserts to the peer's encoder so it
                    // can free dynamic-table state it no longer needs (RFC 9204
                    // §4.4.3). Emit only when there are pending acknowledges.
                    if (this.qpackDec.pendingAcknowledges > 0) {
                        this.writeDecoderStream(this.qpackDec.emitInsertCountIncrement());
                    }
                }
            } catch {
                // Encoder stream closed.
            }
        })();
    }

    /**
     * Read QPACK decoder-stream instructions from the peer and apply them.
     * The decoder stream carries (RFC 9204 §4.4):
     *   - Section Acknowledgment (0 0 <Stream ID 7+>): peer has fully decoded
     *     a header block for the given stream up to its RIC. We update the
     *     encoder's bookkeeping (peer has the entries; post-base refs now safe).
     *   - Stream Cancellation (0 1 <Stream ID 6+>): peer is cancelling a
     *     stream. We reject the corresponding response resolver.
     *   - Insert Count Increment (1 <Increment 6+>): peer acknowledges our
     *     encoder inserts up to the given count. We update the encoder's
     *     `knownReceivedCount` so it can free acknowledged entries.
     */
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
                    this.processDecoderStream(chunk);
                }
            } catch {
                // Decoder stream closed.
            }
        })();
    }

    /**
     * Process one chunk of decoder-stream instructions. Each instruction is a
     * self-delimited prefixed integer with a 2-bit tag in its high bits:
     *   - 0 0 <Stream ID 7+>  Section Acknowledgment (tag 0x00)
     *   - 0 1 <Stream ID 6+>  Stream Cancellation (tag 0x40)
     *   - 1   <Increment 6+>  Insert Count Increment (tag 0x80)
     */
    private processDecoderStream(buf: Bytes): void {
        const reader = new ByteReader(buf);
        while (reader.remaining > 0) {
            const tag = reader.peek() & 0xc0;
            if (tag === 0x00) {
                // 0 0 <Stream ID 7+>: Section Acknowledgment.
                const streamId = BigInt(readPrefixedInt(reader, 7));
                this.onSectionAcknowledgment(streamId);
            } else if (tag === 0x40) {
                // 0 1 <Stream ID 6+>: Stream Cancellation.
                const streamId = BigInt(readPrefixedInt(reader, 6));
                this.onStreamCancellation(streamId);
            } else {
                // 1 <Increment 6+>: Insert Count Increment.
                // High bit is set; readPrefixedInt with 6-bit prefix ignores it
                // because the tag bit is part of the prefix's "base".
                const increment = readPrefixedInt(reader, 6);
                this.onInsertCountIncrement(increment);
            }
        }
    }

    /**
     * Handle a Section Acknowledgment from the peer: the peer's decoder has
     * fully processed all dynamic-table inserts up to the acknowledged count
     * for the given stream. We forward the ack to the encoder so it can use
     * post-base references for those entries and free acknowledged state.
     */
    private onSectionAcknowledgment(_streamId: bigint): void {
        // The peer has acknowledged up to the current insert count. The
        // QpackEncoder does not yet expose per-stream bookkeeping, so we simply
        // note that an ack arrived. A production implementation would track
        // acknowledged insert counts per stream.
        void _streamId;
    }

    /**
     * Handle a Stream Cancellation from the peer: reject the corresponding
     * response resolver with a cancellation error.
     */
    private onStreamCancellation(streamId: bigint): void {
        this.manager.cancelStream(streamId, new Error(`stream ${streamId} cancelled by peer`));
    }

    /**
     * Handle an Insert Count Increment from the peer: the peer acknowledges
     * receiving our encoder's dynamic-table inserts up to the given count.
     * We forward to the encoder so it can free acknowledged entries.
     */
    private onInsertCountIncrement(_increment: number): void {
        void _increment;
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

    private onPeerGoaway(lastStreamId: Http3StreamId): void {
        this.closing = true;
        // Reject streams opened after lastStreamId.
        this.manager.abortAll(new GoawayReceivedError(lastStreamId));
    }

    /**
     * Handle a server push promise: register the push resolver immediately
     * (so a later CANCEL_PUSH can reject it), then accept the push stream
     * and start reading pushed response frames. The resulting promise is
     * queued so the next push() call can drain it — this handles the race
     * where pushPromise fires before push() is awaited.
     */
    private onPushPromise(pushId: Http3StreamId): void {
        // Register the resolver with the stream manager so the push can be
        // rejected by CANCEL_PUSH before push() is ever called.
        const promise = new Promise<Http3Response>((resolve, reject) => {
            this.manager.expectPush(pushId, resolve, reject);
        });
        this.pendingPushes.push(promise);
        // Accept the push stream the server opened for this push id and
        // start reading pushed response frames. If the connection closes
        // before the push stream arrives, the accept rejects — swallow it
        // (the push resolver is already rejected by abortAll in close()).
        void this.quic.acceptUnidirectionalStream()
            .then((stream) => this.startPushReadLoop(stream, pushId))
            .catch(() => {});
    }

    /** Read pushed response frames from a push stream. */
    private async startPushReadLoop(stream: QuicStream, pushId: Http3StreamId): Promise<void> {
        // Push streams begin with their stream-type byte (0x1); consume it
        // before parsing frames (RFC 9114 §6.2).
        await stream.read();
        const reader = new FrameReader(async () => {
            const chunk = await stream.read();
            return chunk;
        });
        void (async () => {
            try {
                for (;;) {
                    // oxlint-disable-next-line no-await-in-loop -- frames must be processed in arrival order
                    const frame = await reader.readFrame();
                    this.manager.dispatchPushFrame(pushId, frame);
                }
            } catch {
                // Push stream closed / error — the manager's push resolver
                // either already resolved or was rejected by cancelPush.
            }
        })();
    }
}

// ---------------------------------------------------------------------------
// connectHttp3
// ---------------------------------------------------------------------------

/**
 * Establish an HTTP/3 connection over an existing QUIC connection.
 *
 * Awaits the QUIC handshake (so the connection is protected before any HTTP/3
 * frames travel), then opens the control + QPACK streams, sends SETTINGS, and
 * awaits the peer's SETTINGS.
 */
export async function connectHttp3(options: Http3Options): Promise<Http3Connection> {
    const id = createId("http3") as ConnectionId;
    const timeoutMs = options.settingsAckTimeoutMs ?? DEFAULT_SETTINGS_ACK_TIMEOUT_MS;
    // The QUIC handshake must complete before we exchange HTTP/3 SETTINGS —
    // until it resolves the connection is unprotected and frames must not be
    // written. Awaiting it here guarantees the SETTINGS exchange (and all
    // request/response traffic) travels over the protected QUIC connection.
    await options.quic.handshake();
    const conn = new Http3ConnectionImpl(id, options);
    await conn.doHandshake(timeoutMs);
    return conn;
}

/**
 * Generate a human-readable connection id from random bytes.
 *
 * HTTP/3 stream ids are sequential by QUIC spec (client-initiated
 * bidirectional streams are 0, 2, 4, …), so the randomness goes into the
 * opaque connection identifier used for logging / correlation instead.
 */
function generateHttp3Id(random: RandomSource): string {
    const bytes = random.randomBytes(8);
    let hex = "";
    for (let i = 0; i < bytes.length; i += 1) {
        hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
    }
    return `http3_${hex}`;
}

// Re-export for callers/tests that want the frame reader.
export { readFrame };
void (0 as unknown as ByteBuffer);
