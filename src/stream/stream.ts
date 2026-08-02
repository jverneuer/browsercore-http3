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
 * TODO (Step 5 of PLAN.md): implement the stream manager.
 */

import type { Http3Response } from "../types.js";

/** A single HTTP/3 request/response exchange on a bidirectional stream. */
export interface Http3Stream {
    /** QUIC stream id (62-bit, client-initiated streams are even). */
    readonly id: bigint;
    /** True once the request's END-of-DATA was written. */
    readonly requestComplete: boolean;
    /** True once the response HEADERS arrived. */
    readonly responseHeadersComplete: boolean;
}

/** A handle the stream manager exposes to the connection for sending. */
export interface StreamManager {
    /** Register the response resolver for a client-opened bidirectional stream. */
    expectResponse(
        streamId: bigint,
        resolve: (res: Http3Response) => void,
        reject: (err: Error) => void,
    ): void;

    /** Dispatch a frame read from a bidirectional (request) stream. */
    dispatchRequestFrame(streamId: bigint, payload: Uint8Array): void;

    /** Dispatch a frame read from the control stream. */
    dispatchControlFrame(payload: Uint8Array): void;

    /** Reject every in-flight request with `error`. */
    abortAll(error: Error): void;
}

/** Create a stream manager bound to the connection's frame I/O. */
export function createStreamManager(
    _handlers: {
        sendGoaway: (streamId: bigint) => void;
        sendCancelPush: (pushId: bigint) => void;
    },
): StreamManager {
    void _handlers;
    throw new Error("TODO: implement createStreamManager (Step 5)");
}
