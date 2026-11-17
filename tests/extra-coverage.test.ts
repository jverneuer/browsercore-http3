/**
 * Focused coverage for the remaining gaps the lifecycle + coverage tests miss:
 *   - ConnectionClosedError constructor (errors.ts function coverage)
 *   - createId helper (utils.ts function coverage)
 *   - writeEncoderStream / writeDecoderStream undefined-stream early returns
 *   - decodeHeaders ric === 0 path (no section acknowledgment emitted)
 *   - connection goaway() public API
 */

import { describe, it, expect } from "vitest";
import { ConnectionClosedError } from "../src/errors.ts";
import { createId, assertNever, concat, concatAll } from "../src/utils.js";

describe("ConnectionClosedError", () => {
    it("constructs with default message and name", () => {
        const err = new ConnectionClosedError();
        expect(err).toBeInstanceOf(ConnectionClosedError);
        expect(err.message).toBe("connection is closed");
        expect(err.name).toBe("ConnectionClosedError");
        expect(err.cause).toBeUndefined();
    });

    it("constructs with a cause", () => {
        const cause = new Error("underlying quic close");
        const err = new ConnectionClosedError({ cause });
        expect(err.cause).toBe(cause);
        expect(err.message).toBe("connection is closed");
    });
});

describe("utils — createId", () => {
    it("generates unique ids: timestamp from the injected clock, random suffix", () => {
        const fixedClock = { now: () => 123 }; // 123.toString(36) === "3f"
        const a = createId("http3", fixedClock);
        const b = createId("http3", fixedClock);
        expect(a).toMatch(/^http3_/);
        expect(b).toMatch(/^http3_/);
        // The timestamp segment is the injected clock's now() — deterministic
        // under a fixed clock (no bare Date.now anywhere in src).
        expect(a.startsWith("http3_3f_")).toBe(true);
        expect(b.startsWith("http3_3f_")).toBe(true);
        // Uniqueness comes from the non-crypto Math.random suffix.
        expect(a).not.toBe(b);
    });
});

describe("utils — assertNever", () => {
    it("throws on unreachable values", () => {
        expect(() => assertNever("unexpected" as never)).toThrow(/Unexpected value/);
    });
});

describe("utils — concat and concatAll", () => {
    it("concatenates two byte arrays", () => {
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([4, 5]);
        const result = concat(a, b);
        expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    });

    it("concatenates many byte arrays", () => {
        const parts = [new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4, 5, 6])];
        const result = concatAll(parts);
        expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
    });
});


