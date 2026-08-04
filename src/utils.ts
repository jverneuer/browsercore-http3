/**
 * Small shared helpers for @browsercore/http3.
 */

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
 * Monotonic-ish unique id generator (not cryptographically random).
 *
 * This is the single sanctioned home for `Date.now()` / `Math.random()` in
 * utils — other modules that need an opaque id must call this rather than
 * reaching for randomness directly.
 */
export function createId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
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
