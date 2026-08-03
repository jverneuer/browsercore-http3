# @browsercore/http3

[![npm version](https://img.shields.io/npm/v/@browsercore/http3)](https://www.npmjs.com/package/@browsercore/http3)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jverneuer/browsercore-http3/main/coverage/badge.json)](https://github.com/jverneuer/browsercore-http3/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-http3/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-http3/actions/workflows/ci.yml)

HTTP/3 framing + QPACK over QUIC streams.

> **Status: early scaffolding.** Most of `src/` is currently a set of typed
> stubs that throw `TODO`. See [Implementation plan](#implementation-plan) for
> what exists and what's ahead. The package publishes so the public API and
> type surface can be locked in early.

## Responsibility

HTTP/3 frame parsing/serialization over typed QUIC streams, QPACK header
compression over unidirectional encoder/decoder streams, the control-stream
SETTINGS exchange, GOAWAY graceful shutdown, and PUSH_PROMISE / CANCEL_PUSH /
MAX_PUSH_ID handling. The package knows nothing about the underlying QUIC
transport — it composes over an injected `QuicConnection` interface.

## What it does NOT know about

- UDP / QUIC / TLS 1.3 (handled by the QUIC connection abstraction)
- TCP, DNS, or sockets
- HTTP/1.1 or HTTP/2
- Browser fingerprints

## Current wiring state

**`@browsercore/quic` is declared as a runtime dependency** in
`package.json`, but **nothing in `src/` imports it yet**. The
`QuicConnection` / `QuicStream` interfaces are defined locally in
`src/types.ts` and serve as the contract a concrete QUIC implementation must
satisfy. Once the connection lifecycle is implemented (Steps 6–8 of the plan),
`Http3ConnectionImpl` will accept a `@browsercore/quic` connection through
this interface. Until then the abstraction seam exists but the real backend
is not wired in.

**Not wired into the entrypoint.** `@browsercore/http3` is not yet composed
into `@browsercore/fetch`'s ALPN-driven dispatch (`fetch/src/dispatch.ts`),
so it is not reachable from the top-level `browsersmith` `fetch()`. That
integration lands after the connection lifecycle, request multiplexing, and
GOAWAY are implemented.

## Public API

```ts
import { connectHttp3, GoawayReceivedError } from "@browsercore/http3";

const conn = await connectHttp3({ quic: quicConnection });

const res = await conn.request({
    method: "GET",
    scheme: "https",
    authority: "example.com",
    path: "/index.html",
    headers: new Map([["accept", "text/html"]]),
    body: undefined,
});

console.log(res.statusCode, res.body);
await conn.goaway(0n);
await conn.close();
```

> The functions above are stubs today — calling them throws
> `Error("TODO: implement …")`. The signature is the contract; the
> implementation follows the plan below.

## Types

| Export | Kind | Purpose |
| --- | --- | --- |
| `Http3Connection` | interface | Public contract higher layers depend on |
| `connectHttp3()` | function | Wrap a QUIC connection with HTTP/3 |
| `Http3Frame` | discriminated union | Every HTTP/3 frame variant |
| `Http3FrameType` | const object | RFC 9114 frame type ids |
| `Http3StreamType` | const object | QUIC unidirectional-stream type ids |
| `Http3Settings` | const object | RFC 9114 SETTINGS identifiers |
| `QuicConnection` | interface | Injected QUIC abstraction |
| `Http3Error` | class | Base typed error |
| `GoawayReceivedError` | class | Peer sent GOAWAY |
| `PushCancelledError` | class | Peer cancelled a push |
| `FrameParseError` | class | Malformed frame |
| `QpackDecodeError` | class | Malformed QPACK block |
| `SettingsAckTimeoutError` | class | SETTINGS ACK timed out |
| `SettingsViolationError` | class | Peer violated our SETTINGS |

## Dependency graph

```
@browsercore/http3
  └─ @browsercore/quic      (runtime dep — backend for QuicConnection;
                             not yet imported in src/, see note above)
```

`@browsercore/http3` imports only the `QuicConnection` *type* (defined locally
in `types.ts`) and is tested with a fake QUIC connection. The concrete
`@browsercore/quic` package satisfies this interface but is not yet wired in
at the source level. HTTP/3 needs no crypto of its own (QPACK is
compression-only, and there is no PING frame).

### Shared config

Build, test, and lint config is centralized in the `@browsercore/dev`
package (declared as a `file:../dev` workspace dependency):

- `vitest.config.ts` — `definePackageConfig({ name: "http3" })` from
  `@browsercore/dev/vitest`
- `oxlint.config.ts` — extends the shared base from `@browsercore/dev/oxlint`

## Development

```sh
npm run build        # tsc -p tsconfig.build.json (emit to dist/)
npm run typecheck    # tsc --noEmit (type-check only, no emit)
npm run lint         # oxlint --type-aware src/
npm test             # vitest run
```

Run a **single test** file:

```sh
npx vitest run tests/http3.test.ts
```

Run tests by **name pattern**:

```sh
npx vitest run -t "TODO stubs throw their placeholder error"
```

> Lint targets `src/` only — tests are excluded, matching every other
> `@browsercore/*` package.

## Implementation plan

The package is built in independently testable steps, each with a matching
test file. Steps 1–5 are the wire-format and dispatch layer; steps 6–11 are
the connection lifecycle and end-to-end behavior.

| Step | Topic | Status |
| --- | --- | --- |
| 1 | QUIC varint encode/decode (`frame/varint.ts`) | Partial — `getVarintEncodedLength` done; `encodeVarint`/`decodeVarint` stub |
| 2 | HTTP/3 frame parse/serialize (`frame/frame.ts`) | Stub |
| 3 | QPACK static table + encode/decode (`qpack/qpack.ts`) | Stub |
| 4 | QPACK dynamic table + wire instructions | Stub |
| 5 | Stream manager + control stream (`stream/stream.ts`) | Stub |
| 6 | Connection lifecycle + SETTINGS handshake (`connection.ts`) | Stub |
| 7 | Request/response multiplexing | Stub |
| 8 | GOAWAY + graceful shutdown | Stub |
| 9 | Server push (PUSH_PROMISE, CANCEL_PUSH, MAX_PUSH_ID) | Stub |
| 10 | GREASE + reserved frames | Stub |
| 11 | Integration: fake QUIC + end-to-end | Stub |

Types (`types.ts`), errors (`errors.ts`), and small helpers (`utils.ts`) are
fully implemented and covered by tests. The `dist/` build emits cleanly.
