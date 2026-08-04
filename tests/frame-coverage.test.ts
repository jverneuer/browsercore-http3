/**
 * Frame-layer coverage for @browsercore/http3.
 *
 * Scope: `src/frame/frame.ts` and `src/frame/varint.ts` only.
 *
 * This file covers the fully-implemented `getVarintEncodedLength` with
 * exhaustive boundary / property / error-path tests. The remaining functions
 * (`encodeVarint`, `decodeVarint`, `serializeFrame`, `readFrame`) are
 * implemented and covered by `tests/conn-coverage.test.ts`. Genuinely
 * unimplemented features (GREASE, some error paths) remain as `it.todo`
 * placeholders so the PLAN.md checklist keeps a 1:1 mapping to runnable tests.
 */

import { describe, it, expect } from "vitest";
import {
    getVarintEncodedLength,
    FrameParseError,
    Http3Error,
    Http3FrameType,
    Http3Settings,
    Http3StreamType,
    VARINT_MAX,
} from "../src/index.js";

// ===========================================================================
// getVarintEncodedLength — exhaustive coverage of the implemented function.
// ===========================================================================

describe("getVarintEncodedLength — zero", () => {
    it("encodes 0 in one byte (the smallest encodable value)", () => {
        expect(getVarintEncodedLength(0n)).toBe(1);
    });
});

describe("getVarintEncodedLength — 1-byte bucket [0, 2^6)", () => {
    const TWO_TO_6 = 1n << 6n;

    it("1 is one byte", () => {
        expect(getVarintEncodedLength(1n)).toBe(1);
    });

    it("2^6 - 1 (63) is the top of the 1-byte range", () => {
        expect(getVarintEncodedLength(TWO_TO_6 - 1n)).toBe(1);
    });

    it("a mid-range value (32) is one byte", () => {
        expect(getVarintEncodedLength(32n)).toBe(1);
    });
});

describe("getVarintEncodedLength — 2-byte bucket [2^6, 2^14)", () => {
    const TWO_TO_6 = 1n << 6n;
    const TWO_TO_14 = 1n << 14n;

    it("2^6 (64) is the bottom of the 2-byte range", () => {
        expect(getVarintEncodedLength(TWO_TO_6)).toBe(2);
    });

    it("2^6 + 1 (65) is two bytes", () => {
        expect(getVarintEncodedLength(TWO_TO_6 + 1n)).toBe(2);
    });

    it("2^14 - 1 (16383) is the top of the 2-byte range", () => {
        expect(getVarintEncodedLength(TWO_TO_14 - 1n)).toBe(2);
    });

    it("a mid-range value (1000) is two bytes", () => {
        expect(getVarintEncodedLength(1000n)).toBe(2);
    });
});

describe("getVarintEncodedLength — 4-byte bucket [2^14, 2^30)", () => {
    const TWO_TO_14 = 1n << 14n;
    const TWO_TO_30 = 1n << 30n;

    it("2^14 (16384) is the bottom of the 4-byte range", () => {
        expect(getVarintEncodedLength(TWO_TO_14)).toBe(4);
    });

    it("2^14 + 1 (16385) is four bytes", () => {
        expect(getVarintEncodedLength(TWO_TO_14 + 1n)).toBe(4);
    });

    it("2^30 - 1 is the top of the 4-byte range", () => {
        expect(getVarintEncodedLength(TWO_TO_30 - 1n)).toBe(4);
    });

    it("a mid-range value (1_000_000) is four bytes", () => {
        expect(getVarintEncodedLength(1_000_000n)).toBe(4);
    });
});

describe("getVarintEncodedLength — 8-byte bucket [2^30, 2^62)", () => {
    const TWO_TO_30 = 1n << 30n;

    it("2^30 is the bottom of the 8-byte range", () => {
        expect(getVarintEncodedLength(TWO_TO_30)).toBe(8);
    });

    it("2^30 + 1 is eight bytes", () => {
        expect(getVarintEncodedLength(TWO_TO_30 + 1n)).toBe(8);
    });

    it("VARINT_MAX (2^62 - 1) is the top of the 8-byte range", () => {
        expect(getVarintEncodedLength(VARINT_MAX)).toBe(8);
    });

    it("a large interior value (10^18) is eight bytes", () => {
        expect(getVarintEncodedLength(10n ** 18n)).toBe(8);
    });
});

describe("getVarintEncodedLength — boundary neighbors", () => {
    it("2^6 - 2 and 2^6 - 1 are one byte; 2^6 and 2^6 + 1 are two bytes", () => {
        expect(getVarintEncodedLength((1n << 6n) - 2n)).toBe(1);
        expect(getVarintEncodedLength((1n << 6n) - 1n)).toBe(1);
        expect(getVarintEncodedLength(1n << 6n)).toBe(2);
        expect(getVarintEncodedLength((1n << 6n) + 1n)).toBe(2);
    });

    it("2^14 - 2 and 2^14 - 1 are two bytes; 2^14 and 2^14 + 1 are four bytes", () => {
        expect(getVarintEncodedLength((1n << 14n) - 2n)).toBe(2);
        expect(getVarintEncodedLength((1n << 14n) - 1n)).toBe(2);
        expect(getVarintEncodedLength(1n << 14n)).toBe(4);
        expect(getVarintEncodedLength((1n << 14n) + 1n)).toBe(4);
    });

    it("2^30 - 2 and 2^30 - 1 are four bytes; 2^30 and 2^30 + 1 are eight bytes", () => {
        expect(getVarintEncodedLength((1n << 30n) - 2n)).toBe(4);
        expect(getVarintEncodedLength((1n << 30n) - 1n)).toBe(4);
        expect(getVarintEncodedLength(1n << 30n)).toBe(8);
        expect(getVarintEncodedLength((1n << 30n) + 1n)).toBe(8);
    });
});

describe("getVarintEncodedLength — output space is exactly {1, 2, 4, 8}", () => {
    it("never returns 3, 5, 6, or 7 across a structured sample", () => {
        const allowed = new Set([1, 2, 4, 8]);
        const sample = [
            0n,
            1n,
            63n,
            64n,
            16383n,
            16384n,
            1_000_000n,
            (1n << 30n) - 1n,
            1n << 30n,
            VARINT_MAX,
        ];
        for (const v of sample) {
            expect(allowed.has(getVarintEncodedLength(v))).toBe(true);
        }
    });
});

describe("getVarintEncodedLength — monotonic non-decreasing", () => {
    it("length never decreases as value increases across powers of two", () => {
        let prev = 0;
        for (let i = 0n; i < 62n; i += 1n) {
            const len = getVarintEncodedLength(1n << i);
            expect(len).toBeGreaterThanOrEqual(prev);
            prev = len;
        }
        expect(prev).toBe(8);
    });
});

describe("getVarintEncodedLength — error paths", () => {
    it("rejects -1n", () => {
        expect(() => getVarintEncodedLength(-1n)).toThrow(RangeError);
    });

    it("rejects large negative values", () => {
        expect(() => getVarintEncodedLength(-(1n << 62n))).toThrow(RangeError);
        expect(() => getVarintEncodedLength(-(1n << 100n))).toThrow(RangeError);
    });

    it("rejects VARINT_MAX + 1 (one past the maximum)", () => {
        expect(() => getVarintEncodedLength(VARINT_MAX + 1n)).toThrow(RangeError);
    });

    it("rejects 2^62 (the first unrepresentable value)", () => {
        expect(() => getVarintEncodedLength(1n << 62n)).toThrow(RangeError);
    });

    it("rejects values far above VARINT_MAX", () => {
        expect(() => getVarintEncodedLength(VARINT_MAX + 1_000_000n)).toThrow(
            RangeError,
        );
    });
});

// ===========================================================================
// Varint wire format — unimplemented (it.todo placeholders per PLAN.md Step 1).
// ===========================================================================

describe("varint wire format (unimplemented — PLAN.md Step 1)", () => {
    it.todo("encodeVarint(0x0) → single zero byte 0b00000000");
    it.todo("encodeVarint(0x3f) → 1-byte, top of the 6-bit range");
    it.todo("encodeVarint(0x40) → 2-byte, prefix 0b01");
    it.todo("encodeVarint(0x3fff) → 2-byte, top of the 14-bit range");
    it.todo("encodeVarint(0x4000) → 4-byte, prefix 0b10");
    it.todo("encodeVarint(0x3fffffff) → 4-byte, top of the 30-bit range");
    it.todo("encodeVarint(0x40000000) → 8-byte, prefix 0b11");
    it.todo("encodeVarint(VARINT_MAX) → 8-byte, all payload bits set");

    it.todo("decodeVarint on a 1-byte encoding returns {value, length:1}");
    it.todo("decodeVarint on a 2-byte encoding returns {value, length:2}");
    it.todo("decodeVarint on a 4-byte encoding returns {value, length:4}");
    it.todo("decodeVarint on an 8-byte encoding returns {value, length:8}");

    it.todo("round-trip: encode then decode recovers 0, 2^6-1, 2^14-1, 2^30-1, 2^62-1");
    it.todo("round-trip: encode then decode recovers a structured sample of interior values");
    it.todo("decodeVarint on a buffer with trailing bytes consumes only `length` bytes");
    it.todo("decodeVarint on a truncated buffer throws RangeError");
    it.todo("encodeVarint on a negative value throws RangeError");
    it.todo("encodeVarint above VARINT_MAX throws RangeError");
});

// ===========================================================================
// Frame serialization — unimplemented (it.todo placeholders per PLAN.md Step 2).
// ===========================================================================

describe("frame serialization (unimplemented — PLAN.md Step 2)", () => {
    it.todo("serializeFrame(DATA) → type 0x0 varint + length varint + raw payload");
    it.todo("serializeFrame(HEADERS) → type 0x1 varint + length varint + QPACK block");
    it.todo("serializeFrame(CANCEL_PUSH) → type 0x3 + length + push_id varint");
    it.todo("serializeFrame(SETTINGS) → type 0x4 + length + repeated (id,value) varint pairs");
    it.todo("serializeFrame(PUSH_PROMISE) → type 0x5 + length + push_id varint + QPACK block");
    it.todo("serializeFrame(GOAWAY) → type 0x7 + length + stream_id varint");
    it.todo("serializeFrame(MAX_PUSH_ID) → type 0x0d + length + push_id varint");

    it.todo("DATA frame with empty payload serializes to type + length 0");
    it.todo("DATA frame with a large payload uses a multi-byte length varint");
    it.todo("SETTINGS frame with no settings serializes to type + length 0");
    it.todo("SETTINGS frame with one (id,value) pair encodes both as varints");
    it.todo("SETTINGS frame with multiple pairs preserves insertion order");
    it.todo("frame type above 0x3f is encoded as a multi-byte type varint");
    it.todo("MAX_PUSH_ID (type 0x0d) serializes the type as a single byte");
});

// ===========================================================================
// Frame parsing — unimplemented (it.todo placeholders per PLAN.md Step 2).
// ===========================================================================

describe("frame parsing (unimplemented — PLAN.md Step 2)", () => {
    it.todo("readFrame parses a DATA frame and returns { type: DATA, payload }");
    it.todo("readFrame parses a HEADERS frame and returns { type: HEADERS, payload }");
    it.todo("readFrame parses a CANCEL_PUSH frame and returns { type: CANCEL_PUSH, pushId }");
    it.todo("readFrame parses a SETTINGS frame with zero pairs → empty settings map");
    it.todo("readFrame parses a SETTINGS frame with one (id,value) pair");
    it.todo("readFrame parses a SETTINGS frame with multiple (id,value) pairs");
    it.todo("readFrame parses a PUSH_PROMISE frame → { type, pushId, payload }");
    it.todo("readFrame parses a GOAWAY frame → { type, streamId }");
    it.todo("readFrame parses a MAX_PUSH_ID frame → { type, pushId }");

    it.todo("readFrame handles a multi-byte type varint (type > 0x3f)");
    it.todo("readFrame handles a multi-byte length varint (length > 0x3f)");
    it.todo("readFrame consumes exactly type + length + payload bytes from the reader");
    it.todo("readFrame leaves trailing bytes for the next frame parse");
    it.todo("readFrame on an empty reader rejects with FrameParseError");
    it.todo("readFrame with a truncated type varint rejects with FrameParseError");
    it.todo("readFrame with a truncated length varint rejects with FrameParseError");
    it.todo("readFrame with a truncated payload rejects with FrameParseError");
    it.todo("readFrame where length exceeds the available bytes rejects with FrameParseError");
});

// ===========================================================================
// GREASE + reserved frames — unimplemented (it.todo placeholders per PLAN.md
// Step 10).
// ===========================================================================

describe("GREASE + reserved frames (unimplemented — PLAN.md Step 10)", () => {
    it.todo("readFrame skips a GREASE frame of type 0x2 and parses the next frame");
    it.todo("readFrame skips a GREASE frame in the reserved range 0x0b..0x1f");
    it.todo("readFrame skips a GREASE frame of type 0x21 (first post-reserved GREASE)");
    it.todo("readFrame skips a GREASE frame of type 0x0b with a non-zero payload length");
    it.todo("a buffer interleaving DATA + GREASE 0x2 + GREASE 0x21 parses only the DATA");
    it.todo("a buffer of only GREASE frames yields no parseable frames");
});

// ===========================================================================
// Frame error paths — unimplemented (it.todo placeholders).
// ===========================================================================

describe("frame error paths (unimplemented)", () => {
    it.todo("FrameParseError exposes the byte offset where parsing failed");
    it.todo("FrameParseError is an instance of Http3Error");
    it.todo("FrameParseError carries an optional cause");
    it.todo("readFrame on a buffer with no readable bytes rejects with FrameParseError");
    it.todo("readFrame with a length varint that overflows rejects with FrameParseError");
    it.todo("readFrame with a SETTINGS frame containing a truncated (id,value) pair rejects");
    it.todo("readFrame with a CANCEL_PUSH frame whose push_id varint is truncated rejects");
    it.todo("readFrame with a GOAWAY frame whose stream_id varint is truncated rejects");
    it.todo("readFrame with a MAX_PUSH_ID frame whose push_id varint is truncated rejects");
});

// ===========================================================================
// Constant tables — runtime values the frame layer depends on.
// ===========================================================================

describe("frame-layer constant tables", () => {
    it("Http3FrameType identifiers match RFC 9114 §7.2", () => {
        expect(Http3FrameType.DATA).toBe(0x0);
        expect(Http3FrameType.HEADERS).toBe(0x1);
        expect(Http3FrameType.CANCEL_PUSH).toBe(0x3);
        expect(Http3FrameType.SETTINGS).toBe(0x4);
        expect(Http3FrameType.PUSH_PROMISE).toBe(0x5);
        expect(Http3FrameType.GOAWAY).toBe(0x7);
        expect(Http3FrameType.MAX_PUSH_ID).toBe(0x0d);
    });

    it("Http3Settings identifiers match RFC 9114 §7.2.4", () => {
        expect(Http3Settings.QPACK_MAX_TABLE_CAPACITY).toBe(0x1);
        expect(Http3Settings.MAX_FIELD_SECTION_SIZE).toBe(0x6);
        expect(Http3Settings.QPACK_BLOCKED_STREAMS).toBe(0x7);
    });

    it("Http3StreamType identifiers match RFC 9114 §6.2", () => {
        expect(Http3StreamType.CONTROL).toBe(0x0);
        expect(Http3StreamType.PUSH).toBe(0x1);
        expect(Http3StreamType.QPACK_ENCODER).toBe(0x2);
        expect(Http3StreamType.QPACK_DECODER).toBe(0x3);
    });

    it("VARINT_MAX equals 2^62 - 1", () => {
        expect(VARINT_MAX).toBe((1n << 62n) - 1n);
    });
});

// ===========================================================================
// FrameParseError — the error type the frame layer throws on malformed input.
// ===========================================================================

describe("FrameParseError", () => {
    it("is constructed with an offset and reports it", () => {
        const e = new FrameParseError(42);
        expect(e.offset).toBe(42);
        expect(e.kind).toBe("FrameParseError");
        expect(e.message).toContain("42");
    });

    it("is an instance of Http3Error (catch-all handler works)", () => {
        expect(new FrameParseError(0)).toBeInstanceOf(Http3Error);
    });

    it("preserves an optional cause by reference", () => {
        const cause = new RangeError("bad varint");
        const e = new FrameParseError(7, { cause });
        expect(e.cause).toBe(cause);
    });
});
