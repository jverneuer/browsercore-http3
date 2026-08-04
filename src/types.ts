/**
 * Domain types for @browsercore/http3.
 *
 * HTTP/3 framing + QPACK over QUIC streams. This package owns NO knowledge of
 * UDP, QUIC internals, or TLS 1.3 — it composes exclusively over a QUIC
 * connection abstraction (see `QuicConnection`). Higher layers (fetch,
 * profiles) compose through `Http3Connection`.
 *
 * Key differences from HTTP/2 that shape these types:
 *   - Stream ids are 62-bit, encoded as QUIC-style variable-length integers.
 *   - Frame headers are `Type (varint) | Length (varint) | Payload` — no fixed
 *     9-byte header.
 *   - Frames live on typed QUIC streams (control, push, QPACK encoder/decoder,
 *     request/response), not a single byte stream.
 *   - QPACK (RFC 9204) replaces HPACK and uses unidirectional streams for
 *     dynamic-table synchronization instead of in-band indexing.
 *   - No PRIORITY / WINDOW_UPDATE / PING / RST_STREAM / CONTINUATION frames —
 *     QUIC handles flow control, reset, and liveness.
 */

import type { RandomSource } from "@browsercore/transport";

// ---------------------------------------------------------------------------
// Domain primitives
// ---------------------------------------------------------------------------

/** A contiguous chunk of wire bytes. */
export type Bytes = Uint8Array;

/** Branded HTTP/3 connection identifier (opaque string for logging / correlation). */
export type ConnectionId = string & { __brand: "ConnectionId" };

/** Branded HTTP/3 stream identifier (62-bit, encoded as a QUIC varint). */
export type Http3StreamId = bigint & { __brand: "Http3StreamId" };

// ---------------------------------------------------------------------------
// QUIC abstraction (injected — this package implements none of it)
// ---------------------------------------------------------------------------

/**
 * A bidirectional or unidirectional QUIC stream: a reliable, ordered byte
 * stream. HTTP/3 frames are written here. This is the same shape as the
 * `Transport` the HTTP/2 package consumes, so a QUIC stream slots in wherever
 * a transport stream is expected.
 */
export interface QuicStream {
    /** Write bytes to the stream. Resolves when handed to the kernel / buffered. */
    write(data: Bytes): Promise<void>;
    /** Read the next chunk of bytes, or reject if the stream closes first. */
    read(): Promise<Bytes>;
    /** Close the stream. */
    close(): Promise<void>;
}

/** Why a QUIC connection or stream was closed. */
export type QuicCloseReason =
    | { readonly kind: "client_close" }
    | { readonly kind: "remote_close" }
    | { readonly kind: "error"; readonly error: Error }
    | { readonly kind: "timeout"; readonly afterMs: number };

/**
 * The QUIC connection abstraction HTTP/3 requires. Implemented by the
 * (future) `@browsercore/quic` package; injected here so HTTP/3 stays
 * testable with a fake QUIC connection and has no dependency on QUIC internals.
 */
export interface QuicConnection {
    /** Opaque identifier for logging / correlation. */
    readonly id: string;
    /**
     * Resolve when the QUIC handshake completes and the connection is
     * protected. HTTP/3 SETTINGS exchange may only begin after this resolves —
     * frames written before the handshake complete would travel over an
     * unprotected connection.
     */
    handshake(): Promise<void>;
    /** Open a new bidirectional stream (request/response). */
    openBidirectionalStream(): Promise<QuicStream>;
    /** Accept the next incoming bidirectional stream from the peer. */
    acceptBidirectionalStream(): Promise<QuicStream>;
    /** Open a new unidirectional stream (control / QPACK / push). */
    openUnidirectionalStream(): Promise<QuicStream>;
    /** Accept the next incoming unidirectional stream from the peer. */
    acceptUnidirectionalStream(): Promise<QuicStream>;
    /** Close the QUIC connection with an error code and reason. */
    close(errorCode: bigint, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Variable-length integer encoding (RFC 9000 §16)
// ---------------------------------------------------------------------------

/** Maximum value encodable in a QUIC varint (2^62 - 1). */
export const VARINT_MAX = (1n << 62n) - 1n;

// ---------------------------------------------------------------------------
// HTTP/3 stream types (RFC 9114 §6.2) — encoded on the stream type varint
// ---------------------------------------------------------------------------

/** The fixed unidirectional-stream type identifiers. */
export const Http3StreamType = {
    CONTROL: 0x0,
    PUSH: 0x1,
    QPACK_ENCODER: 0x2,
    QPACK_DECODER: 0x3,
} as const;

export type Http3StreamTypeValue = (typeof Http3StreamType)[keyof typeof Http3StreamType];

// ---------------------------------------------------------------------------
// HTTP/3 frame types (RFC 9114 §7.2) — encoded as a varint
// ---------------------------------------------------------------------------

/** HTTP/3 frame type identifiers. */
export const Http3FrameType = {
    DATA: 0x0,
    HEADERS: 0x1,
    CANCEL_PUSH: 0x3,
    SETTINGS: 0x4,
    PUSH_PROMISE: 0x5,
    GOAWAY: 0x7,
    MAX_PUSH_ID: 0x0d,
    // Reserved range 0xb..0x1f are GREASE / must be ignored.
} as const;

export type Http3FrameTypeValue = (typeof Http3FrameType)[keyof typeof Http3FrameType];

/**
 * Sentinel `type` for a frame whose type is not one of the known variants
 * (GREASE / reserved types per RFC 9114 §7.1). Negative so it can never
 * collide with a real (non-negative) IANA frame type.
 */
export const HTTP3_UNKNOWN_FRAME_TYPE = -1;

// ---------------------------------------------------------------------------
// HTTP/3 SETTINGS identifiers (RFC 9114 §7.2.4) — encoded as a varint
// ---------------------------------------------------------------------------

/** HTTP/3 SETTINGS identifiers. */
export const Http3Settings = {
    QPACK_MAX_TABLE_CAPACITY: 0x1,
    MAX_FIELD_SECTION_SIZE: 0x6,
    QPACK_BLOCKED_STREAMS: 0x7,
    // 0x0, 0x2, 0x3, 0x4, 0x5 are reserved (HTTP/2 settings do not apply).
    // 0x8..0xb reserved.
    // 0x21 and above: GREASE.
} as const;

export type Http3SettingsKey = (typeof Http3Settings)[keyof typeof Http3Settings];

/** A resolved settings map. */
export type Http3SettingsMap = Partial<Record<Http3SettingsKey, number>>;

// ---------------------------------------------------------------------------
// HTTP/3 frames — discriminated union over `type`
// ---------------------------------------------------------------------------

/** The common HTTP/3 frame shape — discriminated by `type`. */
export interface BaseHttp3Frame {
    readonly type: Http3FrameTypeValue;
}

export interface Http3DataFrame extends BaseHttp3Frame {
    readonly type: typeof Http3FrameType.DATA;
    readonly payload: Bytes;
}

export interface Http3HeadersFrame extends BaseHttp3Frame {
    readonly type: typeof Http3FrameType.HEADERS;
    readonly payload: Bytes;
}

export interface Http3CancelPushFrame extends BaseHttp3Frame {
    readonly type: typeof Http3FrameType.CANCEL_PUSH;
    readonly pushId: bigint;
}

export interface Http3SettingsFrame extends BaseHttp3Frame {
    readonly type: typeof Http3FrameType.SETTINGS;
    readonly settings: Http3SettingsMap;
}

export interface Http3PushPromiseFrame extends BaseHttp3Frame {
    readonly type: typeof Http3FrameType.PUSH_PROMISE;
    readonly pushId: bigint;
    readonly payload: Bytes;
}

export interface Http3GoawayFrame extends BaseHttp3Frame {
    readonly type: typeof Http3FrameType.GOAWAY;
    readonly streamId: bigint;
}

export interface Http3MaxPushIdFrame extends BaseHttp3Frame {
    readonly type: typeof Http3FrameType.MAX_PUSH_ID;
    readonly pushId: bigint;
}

/**
 * A frame whose type is not one of the known variants — a GREASE or reserved
 * type (RFC 9114 §7.1). The payload is retained verbatim so callers that wish
 * to forward it can; consumers MUST ignore it. `rawType` preserves the wire
 * type so logs/tests can see what arrived.
 */
export interface Http3UnknownFrame {
    readonly type: typeof HTTP3_UNKNOWN_FRAME_TYPE;
    readonly rawType: number;
    readonly payload: Bytes;
}

/** Every HTTP/3 frame variant — exhaustive discriminated union. */
export type Http3Frame =
    | Http3DataFrame
    | Http3HeadersFrame
    | Http3CancelPushFrame
    | Http3SettingsFrame
    | Http3PushPromiseFrame
    | Http3GoawayFrame
    | Http3MaxPushIdFrame
    | Http3UnknownFrame;

// ---------------------------------------------------------------------------
// QPACK (RFC 9204) — wire instructions on unidirectional streams
// ---------------------------------------------------------------------------

/** A QPACK encoder instruction (writes to the QPACK encoder stream). */
export type QpackEncoderInstruction =
    | { readonly kind: "setDynamicTableCapacity"; readonly capacity: number }
    | { readonly kind: "insertWithNameReference"; readonly nameIndex: number; readonly value: Bytes }
    | { readonly kind: "insertWithoutNameReference"; readonly name: Bytes; readonly value: Bytes }
    | { readonly kind: "duplicate"; readonly index: number };

/** A QPACK decoder instruction (writes to the QPACK decoder stream). */
export type QpackDecoderInstruction =
    | { readonly kind: "sectionAcknowledgment"; readonly streamId: bigint }
    | { readonly kind: "streamCancellation"; readonly streamId: bigint }
    | { readonly kind: "insertCountIncrement"; readonly increment: number };

/** A single name-value header field. */
export interface HeaderField {
    readonly name: string;
    readonly value: string;
}

/** A serialized QPACK/HPACK header block (the payload of a HEADERS frame). */
export type HeaderBlock = Bytes;

// ---------------------------------------------------------------------------
// Clock abstraction (injected — decouples protocol code from wall-clock time)
// ---------------------------------------------------------------------------

/**
 * Time-source abstraction for HTTP/3 internals. Injected via {@link Http3Options}
 * so callers can substitute a deterministic clock in tests instead of relying on
 * the wall clock (`Date.now()` / `setTimeout`). The default is {@link systemClock},
 * backed by the platform primitives.
 *
 * `setTimeout` returns a disposer rather than an opaque handle: a timer and its
 * cancellation are a single unit, so the handle never escapes into protocol code
 * and a fake clock can back both with plain data structures — no platform cast.
 */
export interface Clock {
    /** Milliseconds since epoch — mirrors `Date.now()`. */
    now(): number;
    /**
     * Schedule `callback` after `delayMs`. Returns a disposer that cancels the
     * pending timer when called — mirrors `setTimeout`/`clearTimeout` as one op.
     */
    setTimeout(callback: () => void, delayMs: number): () => void;
}

/** The platform-backed default clock — `Date.now()` + `setTimeout`. */
export const systemClock: Clock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
    },
};

// ---------------------------------------------------------------------------
// Request / response / connection contract
// ---------------------------------------------------------------------------

/** A request on an HTTP/3 bidirectional stream. */
export interface Http3Request {
    readonly method: string;
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Bytes | undefined;
}

/** A response on an HTTP/3 bidirectional stream. */
export interface Http3Response {
    readonly statusCode: number;
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Bytes;
}

/** Public contract for an HTTP/3 connection. */
export interface Http3Connection {
    /** Opaque identifier for logging / correlation. */
    readonly id: ConnectionId;
    /** Current locally-applied settings (after the peer's SETTINGS arrived). */
    readonly settings: Http3SettingsMap;

    /**
     * Open a bidirectional stream, send request headers, and await the full
     * response. Multiplexes concurrently with other in-flight streams.
     */
    request(req: Http3Request): Promise<Http3Response>;

    push(): Promise<Http3Response>;

    /** Send a GOAWAY frame, gracefully shutting down the connection. */
    goaway(streamId: bigint): Promise<void>;

    /** Gracefully close the connection. */
    close(): Promise<void>;
}

/** Options for {@link connectHttp3}. */
export interface Http3Options {
    /** The underlying QUIC connection (already handshaked). */
    readonly quic: QuicConnection;
    /** Initial local settings to advertise in the SETTINGS frame. */
    readonly initialSettings?: Http3SettingsMap;
    /** Timeout for receiving the peer's SETTINGS ACK. Default 5000ms. */
    readonly settingsAckTimeoutMs?: number;
    /**
     * Time source for the connection. Defaults to {@link systemClock}. Inject a
     * deterministic clock in tests to control time without real waits.
     */
    readonly clock?: Clock;
}
