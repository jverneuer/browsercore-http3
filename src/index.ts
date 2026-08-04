/**
 * @browsercore/http3 — public API surface.
 *
 * HTTP/3 framing + QPACK over QUIC streams. No knowledge of UDP, QUIC, or TLS.
 * Higher layers (fetch, profiles) compose exclusively through these exports.
 */

export { connectHttp3, Http3ConnectionImpl } from "./connection.js";

export {
    FrameParseError,
    GoawayReceivedError,
    Http3Error,
    PushCancelledError,
    QpackDecodeError,
    SettingsAckTimeoutError,
    SettingsViolationError,
    ConnectionClosingError,
    ConnectionClosedError,
} from "./errors.js";

export {
    Http3FrameType,
    isGreaseFrameType,
    type BaseHttp3Frame,
    type Http3Frame,
    type Http3FrameOfType,
    type Http3FrameTypeValue,
} from "./frame/frame.js";
export { FrameReader } from "./frame/frame.js";
export { HTTP3_UNKNOWN_FRAME_TYPE, type Http3UnknownFrame } from "./types.js";

export {
    Http3Settings,
    Http3StreamType,
    type Http3CancelPushFrame,
    type Http3DataFrame,
    type Http3GoawayFrame,
    type Http3HeadersFrame,
    type Http3MaxPushIdFrame,
    type Http3PushPromiseFrame,
    type Http3SettingsFrame,
    type Http3SettingsKey,
    type Http3SettingsMap,
    type Http3StreamTypeValue,
} from "./types.js";

export {
    decodeHeaders as qpackDecodeHeaders,
    encodeHeaders as qpackEncodeHeaders,
    QpackDecoder,
    QpackDynamicTable,
    QpackEncoder,
} from "./qpack/qpack.js";
export type { HeaderField, HeaderBlock } from "./qpack/qpack.js";

export { createStreamManager } from "./stream/stream.js";
export type {
    Http3ManagerEventValue,
    Http3Stream,
    StreamManager,
    StreamManagerHandlers,
} from "./stream/stream.js";

export {
    type ConnectionId,
    type Http3Connection,
    type Http3Options,
    type Http3Request,
    type Http3Response,
    type Http3StreamId,
    type QuicConnection,
    type QuicCloseReason,
    type QuicStream,
} from "./types.js";

export { decodeVarint, encodeVarint, getVarintEncodedLength } from "./frame/varint.js";
export type { DecodedVarint } from "./frame/varint.js";
export { VARINT_MAX } from "./types.js";
export type { Bytes } from "./types.js";

export { assertNever, createId } from "./utils.js";
