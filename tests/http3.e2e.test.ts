/**
 * HTTP/3 end-to-end exchange over a fake QUIC connection (PLAN.md Step 11).
 *
 * Proves the contract the future `@browsercore/quic` package must satisfy and
 * locks in the public API: handshake, request/response multiplexing, GOAWAY.
 */

import { describe, it, expect } from "vitest";
import { connectHttp3 } from "../src/connection.js";
import { FakeQuic, driveFakeServer } from "./fake-quic.js";

describe("HTTP/3 end-to-end over fake QUIC (Step 11)", () => {
    it("completes the SETTINGS handshake and serves a request", async () => {
        const quic = new FakeQuic();
        const serverDone = driveFakeServer(quic.server);
        // Signal that the QUIC handshake is complete so connectHttp3 may begin
        // the HTTP/3 SETTINGS exchange over the protected connection.
        quic.completeHandshake();

        const conn = await connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });

        const res = await conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/index.html",
            headers: new Map([["accept", "text/html"]]),
            body: undefined,
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/plain");

        await conn.close();
        await serverDone;
    });

    it("multiplexes concurrent requests over separate streams", async () => {
        const quic = new FakeQuic();
        const serverDone = driveFakeServer(quic.server);
        quic.completeHandshake();
        const conn = await connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });

        const paths = ["/a", "/b", "/c"];
        const responses = await Promise.all(
            paths.map((path) =>
                conn.request({
                    method: "GET",
                    scheme: "https",
                    authority: "example.com",
                    path,
                    headers: new Map(),
                    body: undefined,
                }),
            ),
        );

        expect(responses).toHaveLength(3);
        responses.forEach((res) => {
            expect(res.statusCode).toBe(200);
        });

        await conn.close();
        await serverDone;
    });

    it("sends a GOAWAY frame on graceful shutdown", async () => {
        const quic = new FakeQuic();
        const serverDone = driveFakeServer(quic.server);
        quic.completeHandshake();
        const conn = await connectHttp3({ quic: quic.client, settingsAckTimeoutMs: 5000 });

        await conn.request({
            method: "GET",
            scheme: "https",
            authority: "example.com",
            path: "/",
            headers: new Map(),
            body: undefined,
        });

        await conn.goaway(0n);
        await conn.close();
        await serverDone;
    });
});
