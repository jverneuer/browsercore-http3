# @browsercore/http3 — Implementation Plan

HTTP/3 framing + QPACK over QUIC streams. Implement in this order; each step
is independently testable against its stub in `src/`.

## Architectural note: the QUIC dependency

HTTP/3 runs over QUIC, not TCP. Unlike `@browsercore/http2` — which consumes
a single duplex byte stream (`Transport`) — HTTP/3 maps frames onto **typed
QUIC streams**. This package therefore depends on a `QuicConnection`
abstraction (defined in `types.ts`) that exposes:

- `openBidirectionalStream()` / `acceptBidirectionalStream()` — for requests.
- `openUnidirectionalStream()` / `acceptUnidirectionalStream()` — for the
  control stream and the two QPACK streams.

The concrete QUIC implementation lives in a **future `@browsercore/quic`
package** (VISION.md lists "QUIC" as a future capability). This package imports
only the `QuicConnection` *type* and is tested with a fake QUIC connection —
exactly as `@browsercore/http2` is tested with a fake transport. **HTTP/3 must
not depend on QUIC internals**, keeping the dependency graph clean:

```
@browsercore/fetch
  └─ @browsercore/http3
        └─ @browsercore/quic        (future — satisfies QuicConnection)
              └─ @browsercore/crypto
```

Until `@browsercore/quic` exists, the `QuicConnection`/`QuicStream` interfaces
are the contract a future QUIC package must satisfy. The `transport`
dependency is retained because `QuicStream` is intentionally shaped like the
existing `Transport` (write/read/close) so higher layers treat a QUIC stream
uniformly with a TCP/TLS stream.

---

## Step 1 — Variable-length integer encoding

Implement QUIC varint encode/decode (`frame/varint.ts`): two-bit prefix
selects a 1/2/4/8-byte representation, max value 2^62 − 1 (RFC 9000 §16).

`getVarintEncodedLength()` is already implemented; finish `encodeVarint()`
and `decodeVarint()`.

Tests: encode + decode round-trip for boundary values (0, 2^6−1, 2^14−1,
2^30−1, 2^62−1); assert `decodeVarint` returns `{value, length}`; assert
truncated buffers throw `RangeError`; assert negatives and >2^62 throw.

## Step 2 — HTTP/3 frame parse/serialize

Implement `serializeFrame()` and `readFrame()` (`frame/frame.ts`) for every
`Http3Frame` variant (RFC 9114 §7). Wire format per frame: `Type (varint) |
Length (varint) | Payload`. Variants:

| Type | Frame | Payload encoding |
| --- | --- | --- |
| 0x0 | DATA | raw bytes |
| 0x1 | HEADERS | QPACK-encoded header block |
| 0x3 | CANCEL_PUSH | push_id varint |
| 0x4 | SETTINGS | repeated (id varint, value varint) |
| 0x5 | PUSH_PROMISE | push_id varint + QPACK block |
| 0x7 | GOAWAY | stream_id varint |
| 0x0d | MAX_PUSH_ID | push_id varint |

Unknown frame types in the reserved/GREASE ranges (0x2, 0xb..0x1f, 0x21+)
MUST be ignored per RFC 9114 §7.1 — `readFrame` skips them by type-specific
length. Frames illegal on the stream they arrive on (e.g. DATA on the control
stream) are connection errors.

Tests: round-trip each frame type through `serializeFrame` + `readFrame`;
assert SETTINGS encodes/decodes multiple (id,value) pairs; assert unknown/GREASE
types are skipped; assert a frame arriving on the wrong stream type raises a
connection error.

## Step 3 — QPACK static table + encode/decode

Implement the QPACK static table (RFC 9204 Appendix A) and
`encodeHeaders()`/`decodeHeaders()` (`qpack/qpack.ts`) for literal header
fields with and without indexing. This mirrors HPACK Step 3 in http2 but uses
QPACK's distinct prefix formats (§3.2 — literal with/literal without name
reference).

Tests: encode a header block; decode it back; assert the round trip is exact.
Assert a reference to a static-table entry decodes to the right name/value.

## Step 4 — QPACK dynamic table + wire instructions

Add the dynamic table and the two unidirectional-stream wire codecs
(§2.1, §3.3):

- **Encoder stream** instructions: Set Dynamic Table Capacity, Insert With
  Name Reference, Insert Without Name Reference, Duplicate.
- **Decoder stream** instructions: Section Acknowledgment, Stream
  Cancellation, Insert Count Increment.

`QpackEncoder` tracks inserts and emits encoder-stream instructions;
`QpackDecoder` tracks the known insert count and emits decoder-stream
acknowledgments. The dynamic table evicts oldest-first past
`QPACK_MAX_TABLE_CAPACITY` and honors `QPACK_BLOCKED_STREAMS`.

Tests: fill the dynamic table past its limit; assert the oldest entry is
evicted. Decode a reference to a dynamic-table entry. Round-trip the wire
instructions on synthetic encoder/decoder streams. Assert `blocked streams`
counting is correct.

## Step 5 — Stream manager + control stream

Implement `createStreamManager()` (`stream/stream.ts`). HTTP/3 streams are
typed QUIC streams, so the manager correlates frames by QUIC stream id rather
than a local stream counter:

- **Control stream** (unidirectional, first byte 0x0): carries SETTINGS,
  GOAWAY, MAX_PUSH_ID, CANCEL_PUSH. Exactly one per side — a second control
  stream is a connection error.
- **QPACK encoder/decoder streams** (types 0x2/0x3): carry the dynamic-table
  instructions. Exactly one pair.
- **Push streams** (type 0x1): one per pushed response, push_id-ordered.
- **Bidirectional streams**: one request/response each (HEADERS + optional
  DATA, then response HEADERS + DATA).

The manager dispatches control frames to the connection and request frames to
the right response resolver. Because QUIC provides flow control natively there
is no HTTP/3 window bookkeeping — the manager only tracks request/response
correlation and push state.

Tests: a SETTINGS frame on the control stream is dispatched; a second control
stream raises a connection error; a bidirectional HEADERS + DATA resolves a
registered response; GOAWAY aborts in-flight requests.

## Step 6 — Connection lifecycle + SETTINGS handshake

Implement `connectHttp3()` and `Http3ConnectionImpl` (`connection.ts`):

1. Open the control stream and the two QPACK streams.
2. Write a SETTINGS frame on the control stream.
3. Await the peer's SETTINGS on its control stream — the handshake completes
   once it arrives, or `SettingsAckTimeoutError` fires after the configured
   timeout.
4. Start the QPACK encoder/decoder streams readers.

Apply the peer's SETTINGS locally (`QPACK_MAX_TABLE_CAPTINGS`,
`MAX_FIELD_SECTION_SIZE`, `QPACK_BLOCKED_STREAMS`); reject values that violate
our advertised limits with `SettingsViolationError`.

Tests: a mock peer that replies with SETTINGS completes the handshake. A peer
that never sends SETTINGS fires `SettingsViolationError`/`SettingsAckTimeoutError`.
A second control stream from the peer raises a connection error.

## Step 7 — Request/response multiplexing

Implement `Http3ConnectionImpl.request()`: open an even bidirectional stream,
QPACK-encode request pseudo-headers + headers into a HEADERS frame, write an
optional DATA frame, and resolve once the response HEADERS + end-of-DATA
arrive. Multiple requests multiplex concurrently over separate streams;
responses are correlated by QUIC stream id.

Tests: fire 5 concurrent requests; assert all 5 resolve with the right body.
A request with a body sends HEADERS then DATA. An empty-body request sends
HEADERS only.

## Step 8 — GOAWAY + graceful shutdown

Implement `goaway()`: send a GOAWAY frame with the last client-initiated
stream id, stop opening new streams, let in-flight streams drain, then close.
Handle inbound GOAWAY by raising `GoawayReceivedError` and rejecting streams
opened after the advertised id.

Tests: sending GOAWAY stops new requests. Receiving GOAWAY raises
`GoawayReceivedError` with the last stream id. In-flight requests below the
id still resolve.

## Step 9 — Server push (PUSH_PROMISE, CANCEL_PUSH, MAX_PUSH_ID)

Decode inbound PUSH_PROMISE frames on the control stream, open the push
stream, and expose the pushed response. Handle CANCEL_PUSH by raising
`PushCancelledError` for the push_id and discarding its stream. Honor
MAX_PUSH_ID. This package does NOT initiate push — it only handles push from
the peer.

Tests: a PUSH_PROMISE + push-stream HEADERS + DATA resolves a pushed response.
A CANCEL_PUSH for an in-flight push raises `PushCancelledError`.

## Step 10 — GREASE + reserved frames

Per RFC 9114 §7.2.8, peers may send reserved frame types (0x2, 0xb..0x1f,
0x21+). These MUST be ignored. Real browsers send GREASE frames to prevent
ossification. Wire-format correctness is covered by Step 2's skip logic; add
an explicit GREASE test that a mix of known + reserved frames parses cleanly.

Tests: a buffer interleaving DATA, a reserved 0x2 frame, and a GREASE 0x21
frame parses the DATA and skips the rest.

## Step 11 — Integration: fake QUIC + end-to-end

Build a fake `QuicConnection` (in `tests/`) that satisfies the `QuicConnection`
interface over in-process streams, then drive a full request/response/GOAWAY
exchange end-to-end. This proves the contract the future `@browsercore/quic`
package must satisfy and locks in the public API.

Tests: end-to-end request/response; concurrent multiplexing; GOAWAY; push.

---

## Definition of done

Checklist reflects test status, not implementation status — see step markers.

- [ ] QUIC varint encode/decode round-trips every boundary value.
- [ ] Every HTTP/3 frame type parses and serializes correctly.
- [ ] QPACK static + dynamic tables encode/decode round-trip.
- [ ] QPACK wire instructions encode/decode on encoder/decoder streams.
- [ ] Stream manager dispatches control + request frames by stream id.
- [ ] SETTINGS handshake completes (or times out / violates with a typed error).
- [ ] Multiple requests multiplex concurrently over separate QUIC streams.
- [ ] GOAWAY is sent on shutdown and received as a typed error.
- [ ] PUSH_PROMISE / CANCEL_PUSH / MAX_PUSH_ID are handled (server push).
- [ ] GREASE / reserved frames are ignored.
- [ ] End-to-end exchange passes over a fake QUIC connection.
- [ ] Every test in `tests/` passes; `tsc --build` is clean.
