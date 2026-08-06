/**
 * Zod schemas for HTTP/3 wire boundaries (RFC 9114, RFC 9204).
 *
 * Protocol logic decodes raw transport bytes into intermediate shapes and then
 * constructs typed domain objects from them. Those objects cross a trust
 * boundary: the bytes came from the network and are untrusted. Every such
 * construction goes through a `Schema.parse()` here instead of an unchecked
 * object literal or an `as` cast — so a malformed or unexpected value is caught
 * at the boundary instead of propagating into the state machine.
 *
 *   - {@link Http3FrameSchema} validates each decoded frame in `parseFramePayload`.
 *   - {@link Http3SettingsMapSchema} validates a decoded SETTINGS payload in
 *     `parseSettings`; the per-id validation against the known set narrows the
 *     key to {@link Http3SettingsKey}, so the map is built with no `as` cast.
 *   - {@link HeaderFieldSchema} validates each QPACK field-line representation
 *     the decoders build from wire bytes.
 */

import { z } from "zod";
import {
    Http3FrameType,
    HTTP3_UNKNOWN_FRAME_TYPE,
    Http3Settings,
    type Http3SettingsMap,
} from "./types.js";

// ---------------------------------------------------------------------------
// SETTINGS (RFC 9114 §7.2.4)
// ---------------------------------------------------------------------------

/**
 * The SETTINGS identifiers HTTP/3 defines (RFC 9114 §7.2.4).
 * A decoded id is only valid if it is one of these — the union literal set is
 * the source of truth, so a Zod parse narrows an arbitrary `number` to
 * {@link Http3SettingsKey} with no `as` cast.
 */
export const Http3SettingsKeySchema = z.union([
    z.literal(Http3Settings.QPACK_MAX_TABLE_CAPACITY),
    z.literal(Http3Settings.MAX_FIELD_SECTION_SIZE),
    z.literal(Http3Settings.QPACK_BLOCKED_STREAMS),
]);

/**
 * Validate a decoded SETTINGS payload (repeated id/value pairs) into a settings
 * map. Unknown ids are dropped per RFC 9114 §7.2.4 — a peer may send identifiers
 * we do not understand, and that is not an error. Each retained id is validated
 * against {@link Http3SettingsKeySchema}, which narrows it to
 * {@link Http3SettingsKey} so the resulting map is typed correctly.
 */
export const Http3SettingsMapSchema = z
    .array(
        z.object({
            id: z.number(),
            value: z.number(),
        }),
    )
    .transform((raw) => {
        const map: Http3SettingsMap = {};
        for (const { id, value } of raw) {
            // Validate the id against the known SETTINGS set. A successful
            // parse narrows `id` to Http3SettingsKey, so it can index the map
            // with no `as` cast. Unknown ids are silently dropped per the RFC.
            const parsed = Http3SettingsKeySchema.safeParse(id);
            if (parsed.success) {
                map[parsed.data] = value;
            }
        }
        return map;
    });

/** A validated SETTINGS map, for use as the `settings` field of a frame schema. */
export const Http3SettingsFieldSchema = z.record(z.number(), z.number());

// ---------------------------------------------------------------------------
// HTTP/3 frames (RFC 9114 §7.2) — discriminated union over `type`
// ---------------------------------------------------------------------------

/** DATA frame: type + raw payload bytes. */
export const Http3DataFrameSchema = z.object({
    type: z.literal(Http3FrameType.DATA),
    payload: z.instanceof(Uint8Array),
});

/** HEADERS frame: type + QPACK-encoded header block (raw bytes). */
export const Http3HeadersFrameSchema = z.object({
    type: z.literal(Http3FrameType.HEADERS),
    payload: z.instanceof(Uint8Array),
});

/** CANCEL_PUSH frame: type + push id. */
export const Http3CancelPushFrameSchema = z.object({
    type: z.literal(Http3FrameType.CANCEL_PUSH),
    pushId: z.bigint(),
});

/** SETTINGS frame: type + validated settings map. */
export const Http3SettingsFrameSchema = z.object({
    type: z.literal(Http3FrameType.SETTINGS),
    settings: Http3SettingsFieldSchema,
});

/** PUSH_PROMISE frame: type + push id + QPACK block (raw bytes). */
export const Http3PushPromiseFrameSchema = z.object({
    type: z.literal(Http3FrameType.PUSH_PROMISE),
    pushId: z.bigint(),
    payload: z.instanceof(Uint8Array),
});

/** GOAWAY frame: type + stream id. */
export const Http3GoawayFrameSchema = z.object({
    type: z.literal(Http3FrameType.GOAWAY),
    streamId: z.bigint(),
});

/** MAX_PUSH_ID frame: type + push id. */
export const Http3MaxPushIdFrameSchema = z.object({
    type: z.literal(Http3FrameType.MAX_PUSH_ID),
    pushId: z.bigint(),
});

/**
 * A frame whose type is not one of the known variants (GREASE / reserved per
 * RFC 9114 §7.1). Retains the raw wire type and payload so callers can inspect
 * it; consumers MUST ignore it.
 */
export const Http3UnknownFrameSchema = z.object({
    type: z.literal(HTTP3_UNKNOWN_FRAME_TYPE),
    rawType: z.number(),
    payload: z.instanceof(Uint8Array),
});

/**
 * Every HTTP/3 frame variant, discriminated by `type`. Used to validate a
 * decoded frame in `parseFramePayload` before it crosses into the typed
 * state machine.
 */
export const Http3FrameSchema = z.discriminatedUnion("type", [
    Http3DataFrameSchema,
    Http3HeadersFrameSchema,
    Http3CancelPushFrameSchema,
    Http3SettingsFrameSchema,
    Http3PushPromiseFrameSchema,
    Http3GoawayFrameSchema,
    Http3MaxPushIdFrameSchema,
    Http3UnknownFrameSchema,
]);

// ---------------------------------------------------------------------------
// QPACK field-line representation (RFC 9204 §3)
// ---------------------------------------------------------------------------

/** A single name-value header field decoded from a QPACK header block. */
export const HeaderFieldSchema = z.object({
    name: z.string(),
    value: z.string(),
});
