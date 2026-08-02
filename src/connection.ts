/**
 * HTTP/3 connection implementation.
 *
 * Wires frame parsing/serialization, QPACK, the stream manager, the
 * control-stream SETTINGS exchange, and GOAWAY over an injected
 * `@browsercore/quic` connection.
 *
 * Lifecycle:
 *   1. `connectHttp3()` opens the control stream + the two QPACK streams.
 *   2. It writes a SETTINGS frame on the control stream and awaits the peer's
 *      SETTINGS (the handshake completes once it arrives, or
 *      `SettingsAckTimeoutError` fires after the configured timeout).
 *   3. `request()` opens an even-numbered bidirectional stream, sends a
 *      HEADERS frame (+ optional DATA), and resolves with the response once
 *      response HEADERS + end-of-DATA arrive.
 *
 * TODO (Steps 6–8 of PLAN.md): implement the connection lifecycle, request
 * multiplexing, and GOAWAY.
 */

import type {
    Http3Connection,
    Http3Options,
    Http3Request,
    Http3Response,
    Http3SettingsMap,
} from "./types.js";

/** Concrete HTTP/3 connection. */
export class Http3ConnectionImpl implements Http3Connection {
    public readonly id: string;
    public readonly settings: Http3SettingsMap;

    public constructor(_options: Http3Options) {
        void _options;
        this.id = "TODO";
        this.settings = {};
        throw new Error("TODO: implement Http3ConnectionImpl (Step 6)");
    }

    public request(_req: Http3Request): Promise<Http3Response> {
        void _req;
        return Promise.reject(new Error("TODO: implement request (Step 7)"));
    }

    public goaway(_streamId: bigint): Promise<void> {
        void _streamId;
        return Promise.reject(new Error("TODO: implement goaway (Step 8)"));
    }

    public close(): Promise<void> {
        return Promise.reject(new Error("TODO: implement close (Step 8)"));
    }
}

/**
 * Establish an HTTP/3 connection over an existing QUIC connection.
 *
 * Opens the control + QPACK streams, sends SETTINGS, and awaits the peer's
 * SETTINGS.
 */
export function connectHttp3(_options: Http3Options): Promise<Http3Connection> {
    void _options;
    return Promise.reject(new Error("TODO: implement connectHttp3 (Step 6)"));
}
