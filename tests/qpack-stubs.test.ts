/**
 * QpackEncoder / QpackDecoder instance methods.
 *
 * These were placeholder TODO stubs in an earlier iteration; the methods are
 * now implemented and covered by qpack.test.ts. This file pins the fact that
 * the instance methods are callable (not TODO stubs) without duplicating the
 * full round-trip coverage.
 */

import { describe, it, expect } from "vitest";
import { QpackDecoder, QpackEncoder } from "../src/index.js";

describe("QpackEncoder.encode (implemented)", () => {
    it("returns a block, required insert count, and encoder bytes", () => {
        const enc = new QpackEncoder();
        enc.applyMaxCapacity(1024);
        const result = enc.encode(new Map([["accept", "*/*"]]));
        expect(result.block.length).toBeGreaterThan(0);
        expect(typeof result.requiredInsertCount).toBe("number");
        expect(result.encoderBytes).toBeInstanceOf(Uint8Array);
    });
});

describe("QpackDecoder.decode (implemented)", () => {
    it("decodes a block after consuming its encoder stream", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.applyMaxCapacity(1024);
        dec.applyMaxCapacity(1024);
        const { block, requiredInsertCount, encoderBytes } = enc.encode(
            new Map([["accept", "*/*"]]),
        );
        dec.consumeEncoderStream(encoderBytes);
        const decoded = dec.decode(block, requiredInsertCount);
        expect(decoded.get("accept")).toBe("*/*");
    });
});
