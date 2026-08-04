/**
 * QPACK dynamic table (RFC 9204 §3.2).
 *
 * A FIFO of field-line entries with a configurable capacity. Adding an entry
 * evicts oldest entries until there is room. Entry size = name length + value
 * length + 32 (RFC 9204 §3.2.1). Absolute indices increase monotonically and
 * are stable for the lifetime of an entry (RFC 9204 §3.2.4).
 */

import type { HeaderField } from "../types.js";

/** Per-entry overhead (RFC 9204 §3.2.1). */
const ENTRY_OVERHEAD = 32;

/** A dynamic-table entry with its stable absolute index. */
export interface DynamicEntry extends HeaderField {
    /** Stable absolute index for the lifetime of the entry. */
    readonly absoluteIndex: number;
    /** Encoded size of the entry (name + value + overhead). */
    readonly size: number;
}

/** Compute the wire size of an entry (RFC 9204 §3.2.1). */
export function entrySize(name: string, value: string): number {
    return new TextEncoder().encode(name).length + new TextEncoder().encode(value).length + ENTRY_OVERHEAD;
}

/**
 * The QPACK dynamic table.
 *
 * Holds entries in insertion order (newest last). Tracks the running absolute
 * index and current total size. Eviction is oldest-first when an insertion
 * would exceed capacity.
 */
export class QpackDynamicTable {
    private entries: DynamicEntry[] = [];
    private totalSize = 0;
    private nextAbsoluteIndex = 0;

    /** Current capacity (max total entry size). Zero means inserts are rejected. */
    private capacityValue: number;

    public constructor(capacity = 0) {
        this.capacityValue = capacity;
    }

    /** Number of entries currently stored. */
    public get length(): number {
        return this.entries.length;
    }

    /** Current total encoded size of all entries. */
    public get size(): number {
        return this.totalSize;
    }

    /** Current capacity. */
    public get capacity(): number {
        return this.capacityValue;
    }

    /** Total number of entries ever inserted (the Insert Count). */
    public get insertCount(): number {
        return this.nextAbsoluteIndex;
    }

    /** Set the capacity, evicting to fit if it is reduced (RFC 9204 §3.2.2). */
    public setCapacity(capacity: number): void {
        this.capacityValue = capacity;
        this.evictToFit(Number.POSITIVE_INFINITY);
    }

    /** Look up an entry by absolute index, or undefined if not present. */
    public getByAbsoluteIndex(index: number): DynamicEntry | undefined {
        if (index < 0 || index >= this.nextAbsoluteIndex) {
            return undefined;
        }
        // entries[0] has the smallest absolute index still present.
        const offset = this.entries[0]?.absoluteIndex ?? 0;
        return this.entries[index - offset];
    }

    /** Access an entry by its position in the live table (0 = oldest). */
    public at(position: number): DynamicEntry | undefined {
        return this.entries[position];
    }

    /**
     * Resolve a relative index (0 = most recent) to an absolute index.
     * Relative index r maps to absolute index (insertCount - 1 - r).
     */
    public relativeToAbsolute(relative: number): number {
        return this.insertCount - 1 - relative;
    }

    /**
     * Insert an entry, evicting oldest entries until it fits. If the entry is
     * larger than the capacity, nothing is inserted (RFC 9204 §3.2.2).
     * Returns the new absolute index, or undefined if it did not fit.
     */
    public insert(name: string, value: string): DynamicEntry | undefined {
        const size = entrySize(name, value);
        if (size > this.capacityValue) {
            return undefined;
        }
        this.evictToFit(size);
        const entry: DynamicEntry = {
            name,
            value,
            absoluteIndex: this.nextAbsoluteIndex,
            size,
        };
        this.nextAbsoluteIndex += 1;
        this.entries.push(entry);
        this.totalSize += size;
        return entry;
    }

    /** Evict entries until `requiredSpace` fits within capacity (or table empty). */
    private evictToFit(requiredSpace: number): void {
        while (this.totalSize > 0 && this.totalSize + requiredSpace > this.capacityValue) {
            const evicted = this.entries.shift();
            if (evicted === undefined) {
                break;
            }
            this.totalSize -= evicted.size;
        }
    }
}
