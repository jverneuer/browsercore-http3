# @browsercore/http3


[![npm version](https://img.shields.io/npm/v/@browsercore/http3)](https://www.npmjs.com/package/@browsercore/http3)
[![coverage](https://img.shields.io/endpoint?url=https://jverneuer.github.io/browsercore-http3/badge.json)](https://github.com/jverneuer/browsercore-http3/blob/main/COVERAGE.md)
[![lint](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-http3/ci.yml?label=lint)](https://github.com/jverneuer/browsercore-http3/actions/workflows/ci.yml)

HTTP/3 framing + QPACK over QUIC streams.

## Responsibility

HTTP/3 frame parsing/serialization over typed QUIC streams, QPACK header
compression over unidirectional encoder/decoder streams, the control-stream
SETTINGS exchange, GOAWAY graceful shutdown, and PUSH_PROMISE / CANCEL_PUSH /
MAX_PUSH_ID handling. The package knows nothing about the underlying QUIC
transport — it could be a real QUIC connection, a pipe, or a test double.

## What it does NOT know about

- UDP / QUIC / TLS 1.3 (handled by the QUIC connection abstraction)
- TCP, DNS, or sockets
- HTTP/1.1 or HTTP/2
- Browser fingerprints

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
  └─ @browsercore/contracts (EventProvider interface — injected, not implemented)
```

The QUIC connection is injected — `@browsercore/http3` imports only the
`QuicConnection` *type*, never a concrete implementation. The concrete QUIC
implementation lives in a separate `@browsercore/quic` package (future) and
satisfies this interface. HTTP/3 needs no crypto of its own (QPACK is
compression-only, and there is no PING frame).

The only `@browsercore/*` runtime dependency is `@browsercore/contracts`, which
supplies the `EventProvider` interface. The concrete event backend is injected
at the composition root (`browsersmith`); this package implements none of it.

## Position in BrowserCore

```
Application
      │
   @browsercore/http3
      │
   @browsercore/quic
      │
     UDP
      │
      IP
```

Every higher networking layer communicates with the network exclusively through the layers below it.

## Contributing

Contributions are welcome — bug reports, reproductions, docs and code alike. Start with [CONTRIBUTING.md](CONTRIBUTING.md); the full guide lives in the [browsersmith repo](https://github.com/jverneuer/browsersmith/blob/main/CONTRIBUTING.md). First timer? Check the [`good first issue`](https://github.com/jverneuer/browsercore-http3/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Security issues: [SECURITY.md](SECURITY.md), never a public issue.
