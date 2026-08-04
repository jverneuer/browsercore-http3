import { describe, it, expect } from "vitest";
import { ByteWriter, writeStringLiteral } from "../src/qpack/encoding.js";

describe("encoding load", () => {
    it("loads writeStringLiteral", () => {
        expect(typeof writeStringLiteral).toBe("function");
        const w = new ByteWriter();
        writeStringLiteral(w, "hello");
        expect(w.toBytes().length).toBeGreaterThan(0);
    });
});
