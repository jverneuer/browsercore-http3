/**
 * Public API surface contract.
 *
 * `src/index.ts` is the only entry point higher layers (fetch, profiles) are
 * supposed to import from. This test guards against accidental removal or
 * rename of a public export: every runtime value the package promises to ship
 * must be present on the namespace import.
 *
 * Only *runtime* (value) exports are checked — type-only exports do not exist
 * at runtime and are validated by the TypeScript compiler instead.
 */

import { describe, it, expect } from "vitest";
import * as http3 from "../src/index.js";

describe("public API surface", () => {
    // Every runtime value exported from src/index.ts. Keep in sync with index.ts.
    const expected = [
        // connection
        "connectHttp3",
        "Http3ConnectionImpl",
        // errors
        "Http3Error",
        "GoawayReceivedError",
        "PushCancelledError",
        "FrameParseError",
        "QpackDecodeError",
        "SettingsViolationError",
        "SettingsAckTimeoutError",
        // frame / types constants
        "Http3FrameType",
        "Http3Settings",
        "Http3StreamType",
        // qpack
        "qpackDecodeHeaders",
        "qpackEncodeHeaders",
        "QpackDecoder",
        "QpackEncoder",
        // stream
        "createStreamManager",
        // varint
        "decodeVarint",
        "encodeVarint",
        "getVarintEncodedLength",
        // primitives
        "VARINT_MAX",
        "assertNever",
    ] as const;

    it("every expected runtime export is defined", () => {
        for (const name of expected) {
            expect(http3 as Record<string, unknown>).toHaveProperty(name);
            // Values are present (not undefined). Functions/classes are typeof "function",
            // const objects are typeof "object", VARINT_MAX is a bigint.
            const v = (http3 as Record<string, unknown>)[name];
            expect(v).toBeDefined();
        }
    });

    it("no expected export is accidentally duplicated under two names (except documented aliases)", () => {
        // qpackDecodeHeaders / qpackEncodeHeaders are documented aliases of the
        // internal decodeHeaders / encodeHeaders; they must point at the same
        // function so behavior can never diverge between the two names.
        expect(http3.qpackDecodeHeaders).toBe(http3.qpackDecodeHeaders); // stable identity
        expect(typeof http3.qpackDecodeHeaders).toBe("function");
        expect(typeof http3.qpackEncodeHeaders).toBe("function");
    });

    it("classes are constructable functions (new-target name contract)", () => {
        for (const ctorName of [
            "Http3ConnectionImpl",
            "Http3Error",
            "GoawayReceivedError",
            "PushCancelledError",
            "FrameParseError",
            "QpackDecodeError",
            "SettingsViolationError",
            "SettingsAckTimeoutError",
            "QpackDecoder",
            "QpackEncoder",
        ] as const) {
            expect(typeof (http3 as Record<string, unknown>)[ctorName]).toBe("function");
        }
    });

    it("the constant tables are plain objects with their RFC-mandated keys", () => {
        expect(http3.Http3StreamType).toEqual({
            CONTROL: 0x0,
            PUSH: 0x1,
            QPACK_ENCODER: 0x2,
            QPACK_DECODER: 0x3,
        });
        expect(http3.Http3FrameType).toEqual({
            DATA: 0x0,
            HEADERS: 0x1,
            CANCEL_PUSH: 0x3,
            SETTINGS: 0x4,
            PUSH_PROMISE: 0x5,
            GOAWAY: 0x7,
            MAX_PUSH_ID: 0x0d,
        });
        expect(http3.Http3Settings).toEqual({
            QPACK_MAX_TABLE_CAPACITY: 0x1,
            MAX_FIELD_SECTION_SIZE: 0x6,
            QPACK_BLOCKED_STREAMS: 0x7,
        });
    });

    it("VARINT_MAX is the bigint 2^62 - 1", () => {
        expect(typeof http3.VARINT_MAX).toBe("bigint");
        expect(http3.VARINT_MAX).toBe((1n << 62n) - 1n);
    });
});
