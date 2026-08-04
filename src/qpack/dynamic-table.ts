/**
 * QPACK dynamic table (RFC 9204 §3.2).
 *
 * A bounded, FIFO table of header fields shared between encoder and decoder.
 * New entries are inserted at the front (highest absolute index); when the
 * total size exceeds the capacity, oldest entries are evicted from the back
 * until the budget is met.
 *
 * Indexing (§3.2.4–§3.2.6):
 *   - Absolute index: the first entry inserted is 0; each insertion increases
 *     it by one. Absolute indices are stable for the lifetime of the entry.
 *   - Relative index: 0 refers to the most recently inserted entry and grows
 *     backward. Relative index `r` maps to absolute index
 *     `insertCount - 1 - r`.
 *   - The encoder stream carries inserts; the decoder rebuilds an identical
 *     table by applying those instructions in order.
 *
 * The index space is separate from the static table (§3.1): a field-line
 * representation carries a `T` bit that selects which table an index refers to.
 */

import type { HeaderField } from "../types.js";

/** Per-entry overhead in bytes (RFC 9204 §3.2.1). */
export const TABLE_ENTRY_OVERHEAD = 32;

/** A single dynamic-table entry — name, value, and its stable absolute index. */
interface DynamicEntry {
    readonly name: string;
    readonly value: string;
    /** Absolute index — assigned at insertion, stable for the entry's lifetime. */
    readonly absIndex: number;
}

/** Default dynamic-table capacity (QPACK starts at 0 until SETTINGS arrives). */
export const DEFAULT_DYNAMIC_CAPACITY = 0;

/** Result of resolving a dynamic-table reference. */
export interface ResolvedDynamic {
    readonly absIndex: number;
    readonly field: HeaderField;
}

export class DynamicTable {
    private entries: DynamicEntry[] = [];
    private currentSize = 0;
    private capacity: number;
    /** Total number of entries ever inserted (monotonic — drives absolute indices). */
    private insertCount = 0;

    constructor(capacity = DEFAULT_DYNAMIC_CAPACITY) {
        this.capacity = capacity;
    }

    /** Current capacity limit (bytes). */
    public get limit(): number {
        return this.capacity;
    }

    /** Current total octet size of all entries (name + value + 32 each). */
    public get size(): number {
        return this.currentSize;
    }

    /** Number of entries currently stored. */
    public get length(): number {
        return this.entries.length;
    }

    /** Total entries ever inserted (the next insertion's absolute index). */
    public getInsertCount(): number {
        return this.insertCount;
    }

    /** Look up an entry by its relative index (0 = most recent). */
    public getByRelativeIndex(relativeIndex: number): DynamicEntry | undefined {
        return this.entries[relativeIndex];
    }

    /** Look up an entry by its absolute index. Returns undefined if not present. */
    public getByAbsoluteIndex(absIndex: number): DynamicEntry | undefined {
        // entries[0] is the most recent = absolute index insertCount - 1.
        const relativeIndex = this.insertCount - 1 - absIndex;
        if (relativeIndex < 0 || relativeIndex >= this.entries.length) {
            return undefined;
        }
        return this.entries[relativeIndex];
    }

    /**
     * Insert a name/value pair at the front. Evicts older entries until the
     * total size fits within capacity. An entry whose own size exceeds the
     * capacity is inserted but causes all other entries to be evicted (the
     * table is flushed except for this entry — RFC 9204 §3.2.2).
     *
     * Returns the absolute index assigned to the new entry.
     */
    public add(name: string, value: string): number {
        const entrySize = name.length + value.length + TABLE_ENTRY_OVERHEAD;
        const absIndex = this.insertCount;
        this.entries.unshift({ name, value, absIndex });
        this.insertCount++;
        this.currentSize += entrySize;
        // If the entry itself exceeds capacity, the only evictable budget is the
        // entry's own size (everything else must go).
        this.evictToFit(this.capacity >= entrySize ? this.capacity : entrySize);
        return absIndex;
    }

    /**
     * Resize the capacity. Evicts entries if the new capacity is smaller than
     * the current total size (§3.2.2). Setting capacity to 0 clears the table.
     */
    public setCapacity(newCapacity: number): void {
        this.capacity = newCapacity;
        this.evictToFit(newCapacity);
    }

    /**
     * Duplicate the entry at the given relative index (§4.3.4) — re-insert it
     * at the front without resending name/value. Returns the new absolute
     * index, or undefined if the relative index is out of range.
     */
    public duplicate(relativeIndex: number): number | undefined {
        const entry = this.entries[relativeIndex];
        if (!entry) {
            return undefined;
        }
        return this.add(entry.name, entry.value);
    }

    /** Evict oldest entries until the total size fits within `budget`. */
    private evictToFit(budget: number): void {
        while (this.currentSize > budget && this.entries.length > 0) {
            const removed = this.entries.pop();
            if (removed) {
                this.currentSize -= removed.name.length + removed.value.length + TABLE_ENTRY_OVERHEAD;
            }
        }
    }
}

/**
 * Resolve a dynamic-table reference to a header field. The reference is an
 * absolute index; returns `undefined` if the entry has been evicted or the
 * index is otherwise not present.
 */
export function resolveDynamic(
    absIndex: number,
    table: DynamicTable,
): ResolvedDynamic | undefined {
    const entry = table.getByAbsoluteIndex(absIndex);
    if (!entry) {
        return undefined;
    }
    return { absIndex, field: { name: entry.name, value: entry.value } };
}

/**
 * Find the most recent dynamic-table entry matching the given name. Returns
 * its absolute index and field, or undefined if none matches. Used by the
 * encoder to decide whether to emit a name reference.
 */
export function findDynamicByName(
    name: string,
    table: DynamicTable,
): ResolvedDynamic | undefined {
    for (let r = 0; r < table.length; r++) {
        const entry = table.getByRelativeIndex(r);
        if (entry && entry.name === name) {
            return { absIndex: entry.absIndex, field: { name: entry.name, value: entry.value } };
        }
    }
    return undefined;
}
