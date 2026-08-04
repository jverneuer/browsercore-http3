/**
 * QPACK static table (RFC 9204 Appendix A).
 *
 * The 99 predefined header entries, indexed 0..98. Unlike HPACK (which is
 * 1-indexed), QPACK's static table is 0-indexed (§3.1). Each entry contributes
 * `name.length + value.length + 32` to the dynamic-table size budget when
 * referenced into the dynamic table, but the static table itself is never
 * evicted and occupies no dynamic-table budget.
 *
 * Lookup helpers support the encoder's name/value matching (§3.1, §4.5).
 */

import type { HeaderField } from "../types.js";

/** A single static-table entry — name + value (value may be empty). */
export interface StaticEntry {
    readonly name: string;
    readonly value: string;
}

/** The 99 entries of the QPACK static table, indexed 0..STATIC_TABLE_LAST. */
export const STATIC_TABLE: readonly StaticEntry[] = [
    { name: ":authority", value: "" },
    { name: ":path", value: "/" },
    { name: "age", value: "0" },
    { name: "content-disposition", value: "" },
    { name: "content-length", value: "0" },
    { name: "cookie", value: "" },
    { name: "date", value: "" },
    { name: "etag", value: "" },
    { name: "if-modified-since", value: "" },
    { name: "if-none-match", value: "" },
    { name: "last-modified", value: "" },
    { name: "link", value: "" },
    { name: "location", value: "" },
    { name: "referer", value: "" },
    { name: "set-cookie", value: "" },
    { name: ":method", value: "CONNECT" },
    { name: ":method", value: "DELETE" },
    { name: ":method", value: "GET" },
    { name: ":method", value: "HEAD" },
    { name: ":method", value: "OPTIONS" },
    { name: ":method", value: "POST" },
    { name: ":method", value: "PUT" },
    { name: ":scheme", value: "http" },
    { name: ":scheme", value: "https" },
    { name: ":status", value: "103" },
    { name: ":status", value: "200" },
    { name: ":status", value: "304" },
    { name: ":status", value: "404" },
    { name: ":status", value: "503" },
    { name: "accept", value: "*/*" },
    { name: "accept", value: "application/dns-message" },
    { name: "accept-encoding", value: "gzip, deflate, br" },
    { name: "accept-ranges", value: "bytes" },
    { name: "access-control-allow-headers", value: "cache-control" },
    { name: "access-control-allow-headers", value: "content-type" },
    { name: "access-control-allow-origin", value: "*" },
    { name: "cache-control", value: "max-age=0" },
    { name: "cache-control", value: "max-age=2592000" },
    { name: "cache-control", value: "max-age=604800" },
    { name: "cache-control", value: "no-cache" },
    { name: "cache-control", value: "no-store" },
    { name: "cache-control", value: "public, max-age=31536000" },
    { name: "content-encoding", value: "br" },
    { name: "content-encoding", value: "gzip" },
    { name: "content-type", value: "application/dns-message" },
    { name: "content-type", value: "application/javascript" },
    { name: "content-type", value: "application/json" },
    { name: "content-type", value: "application/x-www-form-urlencoded" },
    { name: "content-type", value: "image/gif" },
    { name: "content-type", value: "image/jpeg" },
    { name: "content-type", value: "image/png" },
    { name: "content-type", value: "text/css" },
    { name: "content-type", value: "text/html; charset=utf-8" },
    { name: "content-type", value: "text/plain" },
    { name: "content-type", value: "text/plain;charset=utf-8" },
    { name: "range", value: "bytes=0-" },
    { name: "strict-transport-security", value: "max-age=31536000" },
    { name: "strict-transport-security", value: "max-age=31536000; includesubdomains" },
    { name: "strict-transport-security", value: "max-age=31536000; includesubdomains; preload" },
    { name: "vary", value: "accept-encoding" },
    { name: "vary", value: "origin" },
    { name: "x-content-type-options", value: "nosniff" },
    { name: "x-xss-protection", value: "1; mode=block" },
    { name: ":status", value: "100" },
    { name: ":status", value: "204" },
    { name: ":status", value: "206" },
    { name: ":status", value: "302" },
    { name: ":status", value: "400" },
    { name: ":status", value: "403" },
    { name: ":status", value: "421" },
    { name: ":status", value: "425" },
    { name: ":status", value: "500" },
    { name: "accept-language", value: "" },
    { name: "access-control-allow-credentials", value: "FALSE" },
    { name: "access-control-allow-credentials", value: "TRUE" },
    { name: "access-control-allow-headers", value: "*" },
    { name: "access-control-allow-methods", value: "get" },
    { name: "access-control-allow-methods", value: "get, post, options" },
    { name: "access-control-allow-methods", value: "options" },
    { name: "access-control-expose-headers", value: "content-length" },
    { name: "access-control-request-headers", value: "content-type" },
    { name: "access-control-request-method", value: "get" },
    { name: "access-control-request-method", value: "post" },
    { name: "alt-svc", value: "clear" },
    { name: "authorization", value: "" },
    { name: "content-security-policy", value: "script-src 'none'; object-src 'none'; base-uri 'none'" },
    { name: "early-data", value: "1" },
    { name: "expect-ct", value: "" },
    { name: "forwarded", value: "" },
    { name: "if-range", value: "" },
    { name: "origin", value: "" },
    { name: "purpose", value: "prefetch" },
    { name: "server", value: "" },
    { name: "timing-allow-origin", value: "*" },
    { name: "upgrade-insecure-requests", value: "1" },
    { name: "user-agent", value: "" },
    { name: "x-forwarded-for", value: "" },
    { name: "x-frame-options", value: "deny" },
    { name: "x-frame-options", value: "sameorigin" },
];

/** The valid index range is 0..STATIC_TABLE_LAST (inclusive). */
export const STATIC_TABLE_LAST = STATIC_TABLE.length - 1;

/** Look up a static-table entry by its 0-based index. Returns undefined if out of range. */
export function getStaticEntry(index: number): StaticEntry | undefined {
    if (index < 0 || index > STATIC_TABLE_LAST) {
        return undefined;
    }
    return STATIC_TABLE[index];
}

/**
 * Find the 0-based static-table index of an exact name+value match, or
 * `undefined` if none exists.
 */
export function findStaticExactIndex(name: string, value: string): number | undefined {
    for (let i = 0; i < STATIC_TABLE.length; i++) {
        const entry = STATIC_TABLE[i];
        if (entry && entry.name === name && entry.value === value) {
            return i;
        }
    }
    return undefined;
}

/**
 * Find the 0-based static-table index of the first entry sharing this name, or
 * `undefined` if the name is not in the table.
 */
export function findStaticNameIndex(name: string): number | undefined {
    for (let i = 0; i < STATIC_TABLE.length; i++) {
        const entry = STATIC_TABLE[i];
        if (entry && entry.name === name) {
            return i;
        }
    }
    return undefined;
}

/** A resolved static-table header field, tagged with its source index. */
export interface ResolvedStatic {
    readonly index: number;
    readonly field: HeaderField;
}

/**
 * Resolve a static-table reference to a header field. Returns `undefined` if
 * the index is out of range.
 */
export function resolveStatic(index: number): ResolvedStatic | undefined {
    const entry = getStaticEntry(index);
    if (!entry) {
        return undefined;
    }
    return { index, field: { name: entry.name, value: entry.value } };
}
