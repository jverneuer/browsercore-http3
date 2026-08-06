/**
 * HTTP/3 stream lifecycle + frame dispatch.
 *
 * HTTP/3 maps frames onto typed QUIC streams instead of multiplexing within a
 * single byte stream:
 *   - Control stream (unidirectional, type 0x0): SETTINGS, GOAWAY, MAX_PUSH_ID.
 *   - QPACK encoder / decoder streams (unidirectional, types 0x2/0x3): dynamic
 *     table synchronization.
 *   - Push stream (unidirectional, type 0x1): pushed responses.
 *   - Bidirectional streams: each carries a single request HEADERS frame
 *     followed by an optional DATA frame, then the response HEADERS + DATA.
 *
 * Because QUIC provides flow control, reliability, and reset natively, there is
 * no HTTP/3 flow-control, WINDOW_UPDATE, RST_STREAM, or PING. The stream
 * manager here tracks per-stream request/response correlation and dispatches
 * frames to the right resolver.
 *
 * The manager is I/O-free: it consumes parsed {@link Http3Frame} objects and
 * emits typed events. The connection layer owns the QUIC streams and the
 * {@link FrameReader}; it translates wire bytes into frames and feeds them
 * here.
 */

import {
    Http3FrameType,
    HTTP3_UNKNOWN_FRAME_TYPE,
    type Bytes,
    type EventEmitterLike,
    type Http3Frame,
    type Http3Response,
    type Http3StreamId,
} from "../types.js";
import { GoawayReceivedError, PushCancelledError } from "../errors.js";
import { assertNever } from "../utils.js";

/**
 * Stream-manager event names (discriminated union of the events the manager
 * emits). Centralised here so handlers and emitters share one source of truth.
 */
export const Http3ManagerEvent = {
    /** A PUSH_PROMISE arrived on a request stream — payload is the QPACK block. */
    PushPromise: "pushPromise",
    /** The peer's SETTINGS frame arrived (handshake completion signal). */
    Settings: "settings",
    /** The peer sent a GOAWAY — `detail` is the last acceptable stream id. */
    Goaway: "goaway",
    /** The peer sent a MAX_PUSH_ID frame — `detail` is the new max push id. */
    MaxPushId: "maxPushId",
} as const;

export type Http3ManagerEventValue =
    (typeof Http3ManagerEvent)[keyof typeof Http3ManagerEvent];

/** Per-bidirectional-stream response accumulation. */
interface PendingResponse {
    readonly streamId: Http3StreamId;
    readonly kind: "request" | "push";
    readonly resolve: (res: Http3Response) => void;
    readonly reject: (err: Error) => void;
    headerBlock: Bytes;
    body: Bytes[];
    headersComplete: boolean;
    endStreamSeen: boolean;
}

/** A single HTTP/3 request/response exchange on a bidirectional stream. */
export interface Http3Stream {
    /** QUIC stream id (62-bit, client-initiated streams are even). */
    readonly id: Http3StreamId;
    /** True once the request's END-of-DATA was written. */
    readonly requestComplete: boolean;
    /** True once the response HEADERS arrived. */
    readonly responseHeadersComplete: boolean;
}

/**
 * Callbacks the stream manager uses to send control frames back on the
 * connection. Injected so the manager stays I/O-free and testable.
 */
export interface StreamManagerHandlers {
    /** Send a GOAWAY frame, announcing the last acceptable stream id. */
    readonly sendGoaway: (streamId: Http3StreamId) => void;
    /** Send a CANCEL_PUSH frame for the given push id. */
    readonly sendCancelPush: (pushId: bigint) => void;
    /** Emit a response HEADERS frame's decoded status for the connection. */
    readonly onResponseHeaders?: (streamId: Http3StreamId, statusCode: number) => void;
}

/** A handle the stream manager exposes to the connection for sending. */
export interface StreamManager {
    /** Register the response resolver for a client-opened bidirectional stream. */
    expectResponse(
        streamId: Http3StreamId,
        resolve: (res: Http3Response) => void,
        reject: (err: Error) => void,
    ): void;

    /** Register the pushed-response resolver for a server push (push id == stream id). */
    expectPush(
        pushId: Http3StreamId,
        resolve: (res: Http3Response) => void,
        reject: (err: Error) => void,
    ): void;

    /** Dispatch a frame read from a bidirectional (request) stream. */
    dispatchRequestFrame(streamId: Http3StreamId, frame: Http3Frame): void;

    /** Dispatch a frame read from the control stream. */
    dispatchControlFrame(frame: Http3Frame): void;

    /** Dispatch a frame read from a push stream (push id == stream id). */
    dispatchPushFrame(streamId: Http3StreamId, frame: Http3Frame): void;

    /** Reject every in-flight request with `error`. */
    abortAll(error: Error): void;

    /** Reject a single in-flight request by stream id (Stream Cancellation). */
    cancelStream(streamId: bigint, error: Error): void;

    /** Set the QPACK header-block decoder used for response HEADERS frames. */
    setHeaderDecoder(decoder: HeaderDecoder): void;
}

/**
 * Decode a QPACK header block into a header map. The `streamId` is the
 * stream the block was received on, so the decoder can emit per-stream
 * Section Acknowledgments (RFC 9204 §4.4.1). The connection injects its
 * {@link QpackDecoder} here; the manager stays decoupled from QPACK internals.
 */
export type HeaderDecoder = (block: Bytes, streamId: bigint) => ReadonlyMap<string, string>;

/**
 * Minimal EventEmitter-shaped facade over the platform {@link EventTarget}.
 *
 * `unicorn/prefer-event-target` forbids `new EventEmitter()`, so the manager
 * backs its public `EventEmitter` contract (`on`/`once`/`off`/`emit`) with an
 * `EventTarget`, translating via `CustomEvent.detail`.
 */
class StreamEventBridge extends EventTarget {
    private readonly wrappers = new Map<(...args: unknown[]) => void, { wrapper: EventListener; event: string }>();

    public on(event: string | symbol, listener: (...args: unknown[]) => void): void {
        const wrapper = ((e: Event) => {
            listener(...(e as CustomEvent<unknown[]>).detail);
        }) as EventListener;
        const key = event as string;
        this.wrappers.set(listener, { wrapper, event: key });
        this.addEventListener(key, wrapper);
    }

    public once(event: string | symbol, listener: (...args: unknown[]) => void): void {
        const wrapper = ((e: Event) => {
            this.wrappers.delete(listener);
            listener(...(e as CustomEvent<unknown[]>).detail);
        }) as EventListener;
        const key = event as string;
        this.wrappers.set(listener, { wrapper, event: key });
        this.addEventListener(key, wrapper, { once: true });
    }

    public off(event: string | symbol, listener: (...args: unknown[]) => void): void {
        const entry = this.wrappers.get(listener);
        if (entry !== undefined) {
            this.wrappers.delete(listener);
            this.removeEventListener(event as string, entry.wrapper);
        }
    }

    public removeListener(event: string | symbol, listener: (...args: unknown[]) => void): void {
        this.off(event, listener);
    }

    public removeAllListeners(event?: string | symbol): void {
        const target = event as string | undefined;
        const toRemove: Array<(...args: unknown[]) => void> = [];
        for (const [listener, entry] of this.wrappers) {
            if (target === undefined || entry.event === target) {
                this.removeEventListener(entry.event, entry.wrapper);
                toRemove.push(listener);
            }
        }
        for (const listener of toRemove) {
            this.wrappers.delete(listener);
        }
    }

    public emit(event: string | symbol, ...args: unknown[]): boolean {
        return this.dispatchEvent(new CustomEvent<unknown[]>(event as string, { detail: args }));
    }
}

/** Concatenate many byte arrays into one. */
function concatBytes(parts: readonly Bytes[]): Bytes {
    let total = 0;
    for (const p of parts) {
        total += p.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/** Placeholder header decoder replaced by the connection via setHeaderDecoder. */
const defaultHeaderDecoder: HeaderDecoder = (block, streamId) => {
    void block;
    void streamId;
    throw new Error("stream manager: no header decoder set");
};

/** Create a stream manager bound to the connection's frame I/O. */
export function createStreamManager(handlers: StreamManagerHandlers): StreamManager & EventEmitterLike {
    const emitter = new StreamEventBridge();

    let maxStreamId = 0n;

    // streamId → pending response resolver (client-initiated bidirectional streams).
    const pending = new Map<Http3StreamId, PendingResponse>();
    // pushId → pending pushed response resolver.
    const pushes = new Map<Http3StreamId, PendingResponse>();

    let headerDecoder: HeaderDecoder = defaultHeaderDecoder;

    function finalize(p: PendingResponse): void {
        let statusCode = 200;
        let headers = new Map<string, string>();
        try {
            headers = new Map(headerDecoder(p.headerBlock, p.streamId));
        } catch {
            // Header decode failure surfaces as a 500-style error to the caller.
            p.reject(new Error("QPACK decode failed"));
            return;
        }
        const status = headers.get(":status");
        if (status !== undefined) {
            const n = Number(status);
            if (Number.isFinite(n)) {
                statusCode = n;
            }
        }
        p.resolve({ statusCode, headers, body: concatBytes(p.body) });
    }

    function dispatchRequestFrame(streamId: Http3StreamId, frame: Http3Frame): void {
        // A PUSH_PROMISE arrives on the request stream that triggered the
        // push. It is not part of the response — emit an event so the
        // connection can accept the corresponding push stream and register a
        // resolver for the pushed response.
        if (frame.type === Http3FrameType.PUSH_PROMISE) {
            // `frame.pushId` is a wire `bigint`; cast to the branded
            // `Http3StreamId` the connection's event listener expects.
            emitter.emit(Http3ManagerEvent.PushPromise, frame.pushId as Http3StreamId, frame.payload);
            return;
        }
        const p = pending.get(streamId);
        if (p === undefined) {
            return;
        }
        dispatchToPending(p, frame);
    }

    function dispatchPushFrame(streamId: Http3StreamId, frame: Http3Frame): void {
        const p = pushes.get(streamId);
        if (p === undefined) {
            return;
        }
        dispatchToPending(p, frame);
    }

    function dispatchToPending(p: PendingResponse, frame: Http3Frame): void {
        switch (frame.type) {
            case Http3FrameType.HEADERS:
                p.headerBlock = frame.payload;
                p.headersComplete = true;
                break;
            case Http3FrameType.DATA:
                if (frame.payload.length > 0) {
                    p.body.push(frame.payload);
                }
                p.endStreamSeen = true;
                break;
            case HTTP3_UNKNOWN_FRAME_TYPE:
                // GREASE / reserved — ignore.
                break;
            // Frames illegal on a request/response stream are ignored here;
            // the connection layer enforces stream-type correctness.
            case Http3FrameType.SETTINGS:
            case Http3FrameType.CANCEL_PUSH:
            case Http3FrameType.PUSH_PROMISE:
            case Http3FrameType.GOAWAY:
            case Http3FrameType.MAX_PUSH_ID:
                break;
            default:
                // Exhaustiveness guard — forces a compile error if a frame variant
                // is added without a dispatch branch.
                assertNever(frame);
        }
        if (p.headersComplete && p.endStreamSeen) {
            if (p.kind === "request") {
                pending.delete(p.streamId);
            } else {
                pushes.delete(p.streamId);
            }
            finalize(p);
        }
    }

    function dispatchControlFrame(frame: Http3Frame): void {
        switch (frame.type) {
            case Http3FrameType.SETTINGS:
                emitter.emit(Http3ManagerEvent.Settings);
                break;
            case Http3FrameType.GOAWAY:
                emitter.emit(Http3ManagerEvent.Goaway, frame.streamId);
                break;
            case Http3FrameType.MAX_PUSH_ID:
                emitter.emit(Http3ManagerEvent.MaxPushId, frame.pushId);
                break;
            case Http3FrameType.CANCEL_PUSH:
                // The peer is cancelling a pushed resource — reject the pending
                // push resolver with PushCancelledError so callers can match on
                // `kind` and clean up. The frame's `pushId` is a wire `bigint`;
                // cast to the branded `Http3StreamId` the manager expects.
                cancelPush(frame.pushId as Http3StreamId, new PushCancelledError(frame.pushId));
                break;
            case HTTP3_UNKNOWN_FRAME_TYPE:
                break;
            // A control stream carries only control frames; anything else is
            // ignored here (the connection layer enforces stream-type
            // correctness).
            case Http3FrameType.DATA:
            case Http3FrameType.HEADERS:
            case Http3FrameType.PUSH_PROMISE:
                break;
            default:
                // Exhaustiveness guard — forces a compile error if a frame variant
                // is added without a dispatch branch.
                assertNever(frame);
        }
    }

    function expectResponse(
        streamId: Http3StreamId,
        resolve: (res: Http3Response) => void,
        reject: (err: Error) => void,
    ): void {
        if (streamId > maxStreamId) {
            maxStreamId = streamId;
        }
        pending.set(streamId, {
            streamId,
            kind: "request",
            resolve,
            reject,
            headerBlock: new Uint8Array(0),
            body: [],
            headersComplete: false,
            endStreamSeen: false,
        });
    }

    function expectPush(
        pushId: Http3StreamId,
        resolve: (res: Http3Response) => void,
        reject: (err: Error) => void,
    ): void {
        pushes.set(pushId, {
            streamId: pushId,
            kind: "push",
            resolve,
            reject,
            headerBlock: new Uint8Array(0),
            body: [],
            headersComplete: false,
            endStreamSeen: false,
        });
    }

    function cancelPush(pushId: Http3StreamId, error: Error): void {
        const p = pushes.get(pushId);
        if (p !== undefined) {
            pushes.delete(pushId);
            p.reject(error);
        }
    }

    function abortAll(error: Error): void {
        handlers.sendGoaway(maxStreamId as Http3StreamId);
        for (const pushId of pushes.keys()) {
            handlers.sendCancelPush(pushId);
        }
        for (const p of pending.values()) {
            p.reject(error);
        }
        for (const p of pushes.values()) {
            p.reject(error);
        }
        pending.clear();
        pushes.clear();
    }

    function cancelStream(streamId: bigint, error: Error): void {
        const id = streamId as Http3StreamId;
        const p = pending.get(id);
        if (p !== undefined) {
            pending.delete(id);
            p.reject(error);
        }
    }

    const manager = {
        expectResponse,
        expectPush,
        dispatchRequestFrame,
        dispatchControlFrame,
        dispatchPushFrame,
        abortAll,
        cancelStream,
        setHeaderDecoder(decoder: HeaderDecoder): void {
            headerDecoder = decoder;
        },
        on: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener);
        },
        once: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.once(event, listener);
        },
        off: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.off(event, listener);
        },
        removeListener: (event: string | symbol, listener: (...args: unknown[]) => void) => {
            emitter.removeListener(event, listener);
        },
        removeAllListeners: (event?: string | symbol) => {
            emitter.removeAllListeners(event);
        },
        emit: (event: string | symbol, ...args: unknown[]) => emitter.emit(event, ...args),
    } as StreamManager & EventEmitterLike;

    return manager;
}

export { GoawayReceivedError, PushCancelledError };
