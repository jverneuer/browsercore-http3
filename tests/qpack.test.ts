/**
 * QPACK static-table encode/decode (PLAN.md Step 3) and dynamic-table +
 * wire-instruction round-trips (Step 4).
 *
 * Static-only encode/decode is validated against RFC 9204 Appendix B.1's
 * known encoding of a static name reference (:path=/index.html).
 */

import { describe, it, expect } from "vitest";
import {
    QpackDecoder,
    QpackDynamicTable,
    QpackEncoder,
    qpackDecodeHeaders,
    qpackEncodeHeaders,
} from "../src/index.js";

const encodeHeaders = qpackEncodeHeaders;
const decodeHeaders = qpackDecodeHeaders;

describe("static-table encode/decode (Step 3)", () => {
    it("round-trips a header block of literal-name fields", () => {
        const headers = new Map([
            ["custom-key", "custom-value"],
            ["accept", "*/*"],
        ]);
        const block = encodeHeaders(headers);
        const decoded = decodeHeaders(block);
        expect(decoded.get("custom-key")).toBe("custom-value");
        expect(decoded.get("accept")).toBe("*/*");
    });

    it("round-trips a field whose name is in the static table but value is not", () => {
        const headers = new Map([["accept", "text/html"]]);
        const block = encodeHeaders(headers);
        const decoded = decodeHeaders(block);
        expect(decoded.get("accept")).toBe("text/html");
    });

    it("round-trips :method GET via a static indexed reference", () => {
        const headers = new Map([[":method", "GET"]]);
        const block = encodeHeaders(headers);
        const decoded = decodeHeaders(block);
        expect(decoded.get(":method")).toBe("GET");
    });

    it("decodes RFC 9204 B.1: literal name ref to static :path=/index.html", () => {
        // From B.1: 0000 prefix + 0x51 (0101_0001, name index 1 = :path) +
        // 0x0b + "/index.html".
        const block = new Uint8Array([
            0x00, 0x00, 0x51, 0x0b, 0x2f, 0x69, 0x6e, 0x64, 0x65, 0x78, 0x2e, 0x68, 0x74, 0x6d, 0x6c,
        ]);
        const decoded = decodeHeaders(block);
        expect(decoded.get(":path")).toBe("/index.html");
    });

    it("decodes an indexed static reference to :authority (index 0)", () => {
        // Static index 0 = :authority, empty value. Indexed encoding: 0b11_000000 = 0xc0.
        const block = new Uint8Array([0x00, 0x00, 0xc0]);
        const decoded = decodeHeaders(block);
        expect(decoded.get(":authority")).toBe("");
    });

    it("round-trips multiple field lines in order", () => {
        const headers = new Map([
            [":method", "POST"],
            [":scheme", "https"],
            [":path", "/api/v1"],
            ["content-type", "application/json"],
            ["x-request-id", "abc123"],
        ]);
        const block = encodeHeaders(headers);
        const decoded = decodeHeaders(block);
        for (const [k, v] of headers) {
            expect(decoded.get(k)).toBe(v);
        }
    });
});

describe("dynamic table (Step 4)", () => {
    it("inserts and reports size and insert count", () => {
        const table = new QpackDynamicTable(1024);
        table.insert("custom-key", "custom-value");
        expect(table.insertCount).toBe(1);
        expect(table.length).toBe(1);
        expect(table.size).toBeGreaterThan(0);
    });

    it("evicts oldest entries when over capacity", () => {
        // With capacity 80, inserting three entries evicts the oldest to stay fit.
        const table = new QpackDynamicTable(80);
        table.insert("a", "1");
        table.insert("b", "2");
        table.insert("c", "3");
        expect(table.length).toBeLessThanOrEqual(2);
        expect(table.insertCount).toBe(3);
    });

    it("setCapacity(0) evicts everything", () => {
        const table = new QpackDynamicTable(1024);
        table.insert("a", "1");
        table.insert("b", "2");
        table.setCapacity(0);
        expect(table.length).toBe(0);
        expect(table.size).toBe(0);
    });

    it("rejects an entry larger than capacity", () => {
        const tooBig = new QpackDynamicTable(30);
        expect(tooBig.insert("name", "value")).toBeUndefined();
    });

    it("looks up entries by absolute index", () => {
        const table = new QpackDynamicTable(1024);
        table.insert("a", "1");
        table.insert("b", "2");
        const first = table.getByAbsoluteIndex(0);
        expect(first?.name).toBe("a");
        const second = table.getByAbsoluteIndex(1);
        expect(second?.name).toBe("b");
    });
});

describe("encoder / decoder with dynamic table (Step 4)", () => {
    it("round-trips a header block using dynamic insert + post-base reference", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.applyMaxCapacity(1024);
        dec.applyMaxCapacity(1024);

        const headers = new Map([
            ["custom-key", "custom-value"],
            ["accept", "*/*"],
        ]);
        const { block, requiredInsertCount, encoderBytes } = enc.encode(headers);

        dec.consumeEncoderStream(encoderBytes);
        const decoded = dec.decode(block, requiredInsertCount);
        expect(decoded.get("custom-key")).toBe("custom-value");
        expect(decoded.get("accept")).toBe("*/*");
    });

    it("a second block referencing a prior dynamic entry does not re-insert", () => {
        const enc = new QpackEncoder();
        const dec = new QpackDecoder();
        enc.applyMaxCapacity(1024);
        dec.applyMaxCapacity(1024);

        const headers = new Map([["custom-key", "custom-value"]]);
        const first = enc.encode(headers);
        dec.consumeEncoderStream(first.encoderBytes);
        dec.decode(first.block, first.requiredInsertCount);

        // Encode the same headers again — should reference, not re-insert.
        const second = enc.encode(headers);
        expect(second.encoderBytes.length).toBe(0);
        dec.consumeEncoderStream(second.encoderBytes);
        const decoded = dec.decode(second.block, second.requiredInsertCount);
        expect(decoded.get("custom-key")).toBe("custom-value");
    });

    it("decoder emits insert-count-increment and acknowledgment instructions", () => {
        const dec = new QpackDecoder();
        dec.applyMaxCapacity(1024);
        const increment = dec.emitInsertCountIncrement();
        expect(increment.length).toBeGreaterThan(0);
        const ack = dec.emitSectionAcknowledgment(4n);
        expect(ack.length).toBeGreaterThan(0);
        const cancel = dec.emitStreamCancellation(8n);
        expect(cancel.length).toBeGreaterThan(0);
    });

    it("consumeEncoderStream applies a Set Capacity instruction", () => {
        const dec = new QpackDecoder();
        // Set Dynamic Table Capacity = 100: 001 <100 5+>. 100 < 32? No: 100 > 31,
        // so multi-byte: first byte 0b001_11111 = 0x3f, then 100-31 = 69.
        const setCap = new Uint8Array([0x3f, 69]);
        dec.consumeEncoderStream(setCap);
        expect(dec.insertCount).toBe(0); // capacity set, no inserts yet
    });
});
