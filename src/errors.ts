/**
 * Typed errors for @browsercore/http3.
 *
 * Errors are part of the API — every failure mode is an explicit type so callers
 * can match on `kind` instead of parsing messages.
 */

/** Base class for all HTTP/3 errors. */
export class Http3Error extends Error {
    public readonly kind: string = "Http3Error";
    public override readonly cause: Error | undefined;

    constructor(message: string, options?: { cause?: Error }) {
        super(message, options);
        // `new.target.name` picks up the concrete subclass name automatically.
        this.name = new.target.name;
        this.cause = options?.cause;
    }
}

/** The peer sent a GOAWAY — the connection is going down. */
export class GoawayReceivedError extends Http3Error {
    public override readonly kind = "GoawayReceivedError";
    public readonly lastStreamId: bigint;
    public override readonly cause: Error | undefined;

    constructor(lastStreamId: bigint, options?: { cause?: Error }) {
        super(`GOAWAY received: lastStreamId=${lastStreamId}`, options);
        this.name = "GoawayReceivedError";
        this.lastStreamId = lastStreamId;
        this.cause = options?.cause;
    }
}

/** The peer cancelled a pushed resource via CANCEL_PUSH. */
export class PushCancelledError extends Http3Error {
    public override readonly kind = "PushCancelledError";
    public readonly pushId: bigint;
    public override readonly cause: Error | undefined;

    constructor(pushId: bigint, options?: { cause?: Error }) {
        super(`CANCEL_PUSH for pushId=${pushId}`, options);
        this.name = "PushCancelledError";
        this.pushId = pushId;
        this.cause = options?.cause;
    }
}

/** A frame could not be parsed from the wire. */
export class FrameParseError extends Http3Error {
    public override readonly kind = "FrameParseError";
    public readonly offset: number;
    public override readonly cause: Error | undefined;

    constructor(offset: number, options?: { cause?: Error }) {
        super(`Frame parse error at offset ${offset}`, options);
        this.name = "FrameParseError";
        this.offset = offset;
        this.cause = options?.cause;
    }
}

/** A QPACK header block could not be decoded. */
export class QpackDecodeError extends Http3Error {
    public override readonly kind = "QpackDecodeError";
    public override readonly cause: Error | undefined;

    constructor(message: string, options?: { cause?: Error }) {
        super(`QPACK decode error: ${message}`, options);
        this.name = "QpackDecodeError";
        this.cause = options?.cause;
    }
}

/** The peer violated the SETTINGS limits we advertised. */
export class SettingsViolationError extends Http3Error {
    public override readonly kind = "SettingsViolationError";
    public readonly setting: number;
    public readonly value: number;
    public override readonly cause: Error | undefined;

    constructor(setting: number, value: number, options?: { cause?: Error }) {
        super(`SETTINGS violation: setting=${setting} value=${value}`, options);
        this.name = "SettingsViolationError";
        this.setting = setting;
        this.value = value;
        this.cause = options?.cause;
    }
}

/** The peer acknowledged our SETTINGS frame never arrived within the timeout. */
export class SettingsAckTimeoutError extends Http3Error {
    public override readonly kind = "SettingsAckTimeoutError";
    public readonly timeoutMs: number;
    public override readonly cause: Error | undefined;

    constructor(timeoutMs: number, options?: { cause?: Error }) {
        super(`SETTINGS ACK not received within ${timeoutMs}ms`, options);
        this.name = "SettingsAckTimeoutError";
        this.timeoutMs = timeoutMs;
        this.cause = options?.cause;
    }
}
