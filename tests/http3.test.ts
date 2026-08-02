/**
 * @browsercore/http3 — top-level tests.
 *
 * Each step of PLAN.md adds its own suite here (or a dedicated file). Until a
 * step is implemented, its tests are skipped via `it.todo` / `describe.todo` so
 * the checklist in PLAN.md has a 1:1 mapping to runnable tests.
 *
 * The package is tested against a fake QUIC connection (see Step 11 of
 * PLAN.md) — never a real network — so all suites are deterministic and
 * offline.
 */

import { describe, it, expect } from "vitest";

describe("http3", () => {
    it.todo("Step 1 — varint round-trips every boundary value");
    it.todo("Step 2 — every frame type parses and serializes");
    it.todo("Step 3 — QPACK static table encode/decode round-trip");
    it.todo("Step 4 — QPACK dynamic table + wire instructions");
    it.todo("Step 5 — stream manager dispatches by stream id");
    it.todo("Step 6 — SETTINGS handshake completes or times out");
    it.todo("Step 7 — concurrent request multiplexing");
    it.todo("Step 8 — GOAWAY sent/received");
    it.todo("Step 9 — server push handling");
    it.todo("Step 10 — GREASE / reserved frames ignored");
    it.todo("Step 11 — end-to-end over fake QUIC");
});
