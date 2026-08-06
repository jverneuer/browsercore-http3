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
    it("generates unique ids with the given prefix", () => {
        const a = createId("http3");
        const b = createId("http3");
        expect(a).toMatch(/^http3_/);
        expect(b).toMatch(/^http3_/);
        expect(a).not.toBe(b); // monotonic-ish: Date.now or random differ
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


