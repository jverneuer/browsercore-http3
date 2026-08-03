/**
 * Fills the only coverage gap in src/qpack/qpack.ts: the `encode`/`decode`
 * instance methods on QpackEncoder / QpackDecoder.
 *
 * The constructors throw `TODO` before `this` is returned, so the methods
 * cannot be reached through a normally-constructed instance. They are reachable
 * via the prototype with a stub `this` — the same technique http3.test.ts uses
 * for Http3ConnectionImpl's instance methods. None of the methods touch `this`,
 * so a bare prototype object is sufficient.
 *
 * These pin the current (Step 3/4 of PLAN.md) placeholder behavior. When QPACK
 * is implemented, these tests should be replaced with real encode/decode
 * round-trips.
 */

import { describe, it, expect } from "vitest";
import { QpackDecoder, QpackEncoder } from "../src/index.js";

describe("QpackEncoder.encode (prototype, unimplemented)", () => {
    it("throws its placeholder TODO error", () => {
        const stub = Object.create(QpackEncoder.prototype) as QpackEncoder;
        expect(() => stub.encode(new Map())).toThrow(/TODO/);
    });
});

describe("QpackDecoder.decode (prototype, unimplemented)", () => {
    it("throws its placeholder TODO error", () => {
        const stub = Object.create(QpackDecoder.prototype) as QpackDecoder;
        expect(() => stub.decode(new Uint8Array())).toThrow(/TODO/);
    });
});
