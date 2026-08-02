/**
 * HTTP/3 frame parser and serializer (RFC 9114 §7).
 *
 * Pure wire-format logic — no I/O. Each frame is `Type (varint) | Length
 * (varint) | Payload`. Frames are written onto typed QUIC streams; the frame
 * layer does not own the stream.
 *
 * TODO (Step 2 of PLAN.md): implement serializeFrame / parseFrame for every
 * Http3Frame variant.
 */

import {
    Http3FrameType,
    type BaseHttp3Frame,
    type Http3Frame,
    type Http3FrameTypeValue,
} from "../types.js";
import { assertNever } from "../utils.js";

export {
    Http3FrameType,
    type BaseHttp3Frame,
    type Http3Frame,
    type Http3FrameTypeValue,
};

/** Serialize an HTTP/3 frame to wire bytes (type varint + length varint + payload). */
export function serializeFrame(_frame: Http3Frame): Uint8Array {
    void _frame;
    throw new Error("TODO: implement serializeFrame (Step 2)");
}

/**
 * Read one HTTP/3 frame from a stream reader. Pulls exactly the type, length,
 * and payload bytes. Throws FrameParseError on malformed input.
 */
export async function readFrame(
    _read: () => Promise<Uint8Array>,
): Promise<Http3Frame> {
    void _read;
    throw new Error("TODO: implement readFrame (Step 2)");
}

void assertNever;
