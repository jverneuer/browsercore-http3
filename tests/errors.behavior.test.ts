/**
 * Error-class behavior beyond construction (construction with/without `cause`
 * is covered in http3.test.ts). Focuses on the type hierarchy, the `kind`
 * discriminant used for runtime matching, and the throw/catch contract.
 *
 * `Http3Error` is documented as the "Base class for all HTTP/3 errors"
 * (src/errors.ts:8) and the six other error classes extend it, so a caller
 * writing `if (e instanceof Http3Error)` catches every HTTP/3 failure.
 */

import { describe, it, expect } from "vitest";
import {
    FrameParseError,
    GoawayReceivedError,
    Http3Error,
    PushCancelledError,
    QpackDecodeError,
    SettingsAckTimeoutError,
    SettingsViolationError,
} from "../src/index.js";

/** Build one instance of every error class (the without-cause path). */
function everyError(): Error[] {
    return [
        new Http3Error("a"),
        new GoawayReceivedError(1n),
        new PushCancelledError(2n),
        new FrameParseError(3),
        new QpackDecodeError("a"),
        new SettingsViolationError(0x1, 1),
        new SettingsAckTimeoutError(1),
    ];
}

describe("error hierarchy", () => {
    it("every HTTP/3 error is an instance of Error", () => {
        for (const e of everyError()) {
            expect(e).toBeInstanceOf(Error);
        }
    });

    it("every error carries an Error stack trace", () => {
        for (const e of everyError()) {
            expect(typeof e.stack).toBe("string");
            expect(e.stack!.length).toBeGreaterThan(0);
        }
    });

    it("Http3Error is a base class for all the other errors", () => {
        // Documented as "Base class for all HTTP/3 errors" in src/errors.ts:8,
        // and the subclasses extend Http3Error, so instanceof Http3Error is
        // true for them — catch-all handlers now work as documented.
        expect(new GoawayReceivedError(0n)).toBeInstanceOf(Http3Error);
        expect(new PushCancelledError(0n)).toBeInstanceOf(Http3Error);
        expect(new FrameParseError(0)).toBeInstanceOf(Http3Error);
        expect(new QpackDecodeError("x")).toBeInstanceOf(Http3Error);
        expect(new SettingsViolationError(1, 0)).toBeInstanceOf(Http3Error);
        expect(new SettingsAckTimeoutError(0)).toBeInstanceOf(Http3Error);

        // Http3Error itself is also an instance of Http3Error.
        expect(new Http3Error("x")).toBeInstanceOf(Http3Error);
    });

    it("each subclass is an instance of itself but not of its siblings", () => {
        const g = new GoawayReceivedError(0n);
        expect(g).toBeInstanceOf(GoawayReceivedError);
        expect(g).not.toBeInstanceOf(PushCancelledError);

        const p = new PushCancelledError(0n);
        expect(p).toBeInstanceOf(PushCancelledError);
        expect(p).not.toBeInstanceOf(GoawayReceivedError);
    });
});

describe("kind discriminant", () => {
    it("every error exposes a unique `kind` matching its class name", () => {
        const kinds = everyError().map((e) => (e as { kind: string }).kind);
        expect(kinds).toEqual([
            "Http3Error",
            "GoawayReceivedError",
            "PushCancelledError",
            "FrameParseError",
            "QpackDecodeError",
            "SettingsViolationError",
            "SettingsAckTimeoutError",
        ]);
        // Uniqueness — callers can switch on `kind` without collisions.
        expect(new Set(kinds).size).toBe(kinds.length);
    });

    it("`kind` is an own property (not inherited from Error)", () => {
        for (const e of everyError()) {
            expect(Object.prototype.hasOwnProperty.call(e, "kind")).toBe(true);
        }
    });
});

describe("throw / catch contract", () => {
    it("errors can be thrown and caught by their concrete class", () => {
        const cases: Array<[() => unknown, new (...a: never[]) => Error]> = [
            [() => { throw new GoawayReceivedError(5n); }, GoawayReceivedError],
            [() => { throw new PushCancelledError(5n); }, PushCancelledError],
            [() => { throw new FrameParseError(99); }, FrameParseError],
            [() => { throw new QpackDecodeError("bad"); }, QpackDecodeError],
            [() => { throw new SettingsViolationError(0x6, 7); }, SettingsViolationError],
            [() => { throw new SettingsAckTimeoutError(250); }, SettingsAckTimeoutError],
        ];
        for (const [thrower, ctor] of cases) {
            try {
                thrower();
                expect.unreachable("expected thrower to throw");
            } catch (e) {
                expect(e).toBeInstanceOf(ctor);
                expect(e).toBeInstanceOf(Error);
                void ctor;
            }
        }
    });

    it("the cause reference is identity-preserving", () => {
        const root = new RangeError("orig");
        const wrapped = new QpackDecodeError("outer", { cause: root });
        // Same reference, not a copy — handlers can rethrow the original.
        expect(wrapped.cause).toBe(root);
    });

    it("re-throwing preserves the original instance through a generic handler", () => {
        let caught: unknown = null;
        try {
            throw new GoawayReceivedError(42n);
        } catch (e) {
            caught = e;
        }
        // A generic Error catch must still expose lastStreamId.
        expect(caught).toBeInstanceOf(Error);
        expect((caught as GoawayReceivedError).lastStreamId).toBe(42n);
    });
});
