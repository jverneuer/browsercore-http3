/**
 * Small shared helpers for @browsercore/http3.
 */

import type { Clock } from "@browsercore/contracts";
import type { Bytes } from "./types.js";

/**
 * Exhaustiveness check for `switch`/`if-else` over discriminated unions.
 * Call in the `default` branch: `default: assertNever(x)`.
 * Adding a new union member forces every handler to compile-error until handled.
 */
export function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Monotonic-ish unique id generator.
 *
 * Time is read from the injected canonical `Clock` — never a bare `Date.now()`
 * — so ids are deterministic under an injected test clock. The uniqueness
 * suffix stays `Math.random()`: these ids are for logging / correlation only
 * and are NOT cryptographic, so routing the suffix through a crypto provider
 * would add coupling without benefit. This is the single sanctioned home for
 * `Math.random()` in the package — other modules that need an opaque id must
 * call this rather than reaching for randomness directly.
 */
export function createId(prefix: string, clock: Pick<Clock, "now">): string {
    return `${prefix}_${clock.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Concatenate two byte arrays. */
export function concat(a: Bytes, b: Bytes): Bytes {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Concatenate many byte arrays into one. */
export function concatAll(parts: readonly Bytes[]): Bytes {
    let total = 0;
    for (const p of parts) {
        total += p.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
