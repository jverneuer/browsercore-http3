/**
 * Shared test helpers for http3 tests — an in-memory EventProvider mock and a
 * real-timer-backed canonical Clock.
 *
 * The http3 package provides NO fallback EventProvider and NO fallback Clock;
 * both must be injected (Http3Options). These mocks implement the full
 * contracts interfaces so tests can construct connections without the package
 * pulling in node:events or bare timer globals.
 */

import type { Clock, EventProvider } from "@browsercore/contracts";
import type { ConnectionId, Http3StreamId } from "../src/types.js";

/**
 * Brand a raw value as an Http3StreamId. Tests drive the stream manager and
 * connection directly, and those APIs only accept branded ids (standards §14)
 * — this is the same boundary cast src/connection.ts applies when it
 * allocates ids, kept test-side like quic's makeStreamId helper.
 */
export function makeStreamId(value: number | bigint): Http3StreamId {
    return BigInt(value) as Http3StreamId;
}

/**
 * Brand a raw string as a ConnectionId (mirrors createId()'s boundary cast)
 * so tests can construct Http3ConnectionImpl with a predictable id.
 */
export function makeConnectionId(value: string): ConnectionId {
    return value as ConnectionId;
}

/**
 * Create a minimal in-memory EventProvider. Stand-in for the Node
 * EventEmitter-backed provider that browsersmith injects in production.
 *
 * @returns A fresh EventProvider backed by an in-memory listener map.
 */
export function createMockEventProvider(): EventProvider {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        on(event, listener) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(listener);
        },
        once(event, listener) {
            const wrapped = (...args: unknown[]) => {
                listeners.get(event)?.delete(wrapped);
                listener(...args);
            };
            this.on(event, wrapped);
        },
        off(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        removeListener(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        emit(event, ...args) {
            const set = listeners.get(event);
            if (!set || set.size === 0) return false;
            for (const l of [...set]) l(...args);
            return true;
        },
        listenerCount(event) {
            return listeners.get(event)?.size ?? 0;
        },
        removeAllListeners(event) {
            if (event) listeners.delete(event);
            else listeners.clear();
        },
    };
}

/**
 * Create a real-timer-backed canonical Clock. Stand-in for the platform clock
 * that browsersmith injects in production. Timing semantics stay real (the
 * handshake-timeout tests rely on timers actually firing after N ms); the
 * seam exists so the connection code never touches timer globals directly.
 *
 * @returns A fresh Clock implementing the full contracts surface.
 */
export function createMockClock(): Clock {
    return {
        now: () => Date.now(),
        monotonic: () => performance.now(),
        sleep: (ms) =>
            new Promise<void>((resolve) => {
                globalThis.setTimeout(resolve, ms);
            }),
        setTimeout: (ms, fn) => globalThis.setTimeout(fn, ms),
        clearTimeout: (handle) => {
            globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
        },
    };
}
