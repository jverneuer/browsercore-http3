/**
 * QPACK encoder / decoder (RFC 9204).
 *
 * HTTP/3's replacement for HPACK. Unlike HPACK — which carries its dynamic
 * table updates in-band inside the header block — QPACK uses two dedicated
 * unidirectional QUIC streams (encoder + decoder) to synchronize the dynamic
 * table. This avoids head-of-line blocking: a header block references only the
 * static table plus an insert count, and the peer applies table updates
 * asynchronously on the encoder/decoder streams.
 *
 * Wire instructions (§2.1):
 *   - Encoder stream:   Set Dynamic Table Capacity, Insert With/Without Name
 *                        Reference, Duplicate.
 *   - Decoder stream:   Section Acknowledgment, Stream Cancellation, Insert
 *                        Count Increment.
 *
 * TODO (Steps 3–4 of PLAN.md): implement the static table, encoder, decoder,
 * and the wire-instruction codecs.
 */

import type { HeaderField, HeaderBlock } from "../types.js";

export type { HeaderField, HeaderBlock };

/** Encode a headers map into a QPACK header block. */
export function encodeHeaders(_headers: ReadonlyMap<string, string>): Uint8Array {
    void _headers;
    throw new Error("TODO: implement encodeHeaders (QPACK, Step 3)");
}

/** Decode a QPACK header block into a headers map. */
export function decodeHeaders(_buf: Uint8Array): ReadonlyMap<string, string> {
    void _buf;
    throw new Error("TODO: implement decodeHeaders (QPACK, Step 3)");
}

/** QPACK encoder: produces header blocks + encoder-stream instructions. */
export class QpackEncoder {
    public constructor(_capacity = 0) {
        void _capacity;
        throw new Error("TODO: implement QpackEncoder (Step 4)");
    }
}

/** QPACK decoder: consumes header blocks + decoder-stream instructions. */
export class QpackDecoder {
    public constructor(_capacity = 0) {
        void _capacity;
        throw new Error("TODO: implement QpackDecoder (Step 4)");
    }
}
