/**
 * Edge cases for concat / concatAll beyond the empty-array cases in
 * http3.test.ts. Covers the realities of wire-format code: callers frequently
 * hand in Uint8Array *views* (subarrays/slices of larger buffers), rely on
 * inputs not being mutated, and on the returned buffer being independent of
 * the inputs.
 */

import { describe, it, expect } from "vitest";
import { concat, concatAll } from "../src/utils.js";

describe("concat — Uint8Array views", () => {
    it("copies only the viewed range of a subarray input", () => {
        const backing = new Uint8Array([0, 10, 20, 30, 40, 0]);
        const view = backing.subarray(1, 4); // [10, 20, 30]
        const out = concat(view, view);
        expect(Array.from(out)).toEqual([10, 20, 30, 10, 20, 30]);
    });

    it("handles a view concatenated with a fresh array", () => {
        const backing = new Uint8Array([99, 1, 2, 99]);
        const view = backing.subarray(1, 3); // [1, 2]
        const out = concat(view, new Uint8Array([3, 4]));
        expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    });
});

describe("concat — non-mutation / independence", () => {
    it("does not mutate either input", () => {
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([4, 5, 6]);
        const snapA = Array.from(a);
        const snapB = Array.from(b);
        concat(a, b);
        expect(Array.from(a)).toEqual(snapA);
        expect(Array.from(b)).toEqual(snapB);
    });

    it("returns a buffer that does not alias its inputs", () => {
        const a = new Uint8Array([1, 2]);
        const b = new Uint8Array([3, 4]);
        const out = concat(a, b);
        out[0] = 255;
        out[2] = 255;
        expect(a[0]).toBe(1);
        expect(b[0]).toBe(3);
    });

    it("handles aliasing when both arguments are the same array", () => {
        const a = new Uint8Array([7, 8]);
        const out = concat(a, a);
        expect(Array.from(out)).toEqual([7, 8, 7, 8]);
        // Output is still independent of the input.
        out[0] = 0;
        expect(a[0]).toBe(7);
    });
});

describe("concatAll — view inputs", () => {
    it("joins subarray views alongside full arrays", () => {
        const backing = new Uint8Array([0, 0, 1, 2, 3, 0]);
        const view = backing.subarray(2, 5); // [1, 2, 3]
        const out = concatAll([view, new Uint8Array([4]), view]);
        expect(Array.from(out)).toEqual([1, 2, 3, 4, 1, 2, 3]);
    });
});

describe("concatAll — algebraic properties", () => {
    it("is associative: concatAll([a,b,c]) === concatAll([concatAll([a,b]), c])", () => {
        const a = new Uint8Array([1]);
        const b = new Uint8Array([2, 3]);
        const c = new Uint8Array([4, 5, 6]);
        const left = concatAll([a, b, c]);
        const right = concatAll([concatAll([a, b]), c]);
        expect(Array.from(left)).toEqual(Array.from(right));
    });

    it("total length always equals the sum of part lengths (incl. empties)", () => {
        const parts = [
            new Uint8Array(),
            new Uint8Array([1]),
            new Uint8Array(),
            new Uint8Array([2, 3]),
            new Uint8Array([4, 5, 6]),
        ];
        const expectedLen = parts.reduce((n, p) => n + p.length, 0);
        expect(concatAll(parts).length).toBe(expectedLen);
    });

    it("returns a fresh buffer on every call (no shared backing across calls)", () => {
        const parts = [new Uint8Array([1, 2])];
        const a = concatAll(parts);
        const b = concatAll(parts);
        a[0] = 99;
        expect(b[0]).toBe(1);
    });

    it("handles a large number of small parts", () => {
        const n = 1000;
        const parts = Array.from({ length: n }, (_, i) => new Uint8Array([i & 0xff]));
        const out = concatAll(parts);
        expect(out.length).toBe(n);
        expect(out[0]).toBe(0);
        expect(out[n - 1]).toBe((n - 1) & 0xff);
    });
});
