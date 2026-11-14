import type { RichText } from './richText';
import { WeakIdentityLru } from './weakLru';

const INTERVAL_LIMIT = 4096;
const CACHE_BYTES = 2 * 1024 * 1024;
const CACHE_DOCUMENTS = 8;
interface Interval { from: number; to: number }

/** Sorted disjoint intervals of blocks proved to contain no word-like segment. */
class EmptyBlocks {
    private readonly intervals: Interval[] = [];
    get size(): number { return this.intervals.length; }

    private firstEndingAtOrAfter(index: number): number {
        let low = 0, high = this.intervals.length;
        while (low < high) {
            const mid = low + ((high - low) >>> 1);
            if (this.intervals[mid].to < index) low = mid + 1; else high = mid;
        }
        return low;
    }
    has(index: number): boolean {
        const interval = this.intervals[this.firstEndingAtOrAfter(index)];
        return !!interval && interval.from <= index;
    }
    next(index: number, direction: -1 | 1): number {
        const interval = this.intervals[this.firstEndingAtOrAfter(index)];
        return interval && interval.from <= index ? direction < 0 ? interval.from - 1 : interval.to + 1 : index;
    }
    /** Preserve only unchanged block ordinals when an immutable revision is spliced. */
    splice(first: number, removed: number, inserted: number): EmptyBlocks {
        const result = new EmptyBlocks(), oldEnd = first + removed, shift = inserted - removed;
        const append = (from: number, to: number) => {
            if (from > to) return;
            const last = result.intervals[result.intervals.length - 1];
            if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
            else if (result.intervals.length < INTERVAL_LIMIT) result.intervals.push({ from, to });
        };
        for (const interval of this.intervals) {
            append(interval.from, Math.min(interval.to, first - 1));
            append(Math.max(interval.from, oldEnd) + shift, interval.to + shift);
        }
        return result;
    }
    add(index: number): void {
        const position = this.firstEndingAtOrAfter(index - 1), current = this.intervals[position];
        if (current && current.from <= index + 1) {
            current.from = Math.min(current.from, index); current.to = Math.max(current.to, index);
            const next = this.intervals[position + 1];
            if (next && next.from <= current.to + 1) {
                current.to = Math.max(current.to, next.to);
                this.intervals.splice(position + 1, 1);
            }
        } else if (this.intervals.length < INTERVAL_LIMIT) this.intervals.splice(position, 0, { from: index, to: index });
    }
}

/** Per-revision skip intervals retain no document or block objects. */
export class WordBlockIndex {
    private readonly cache = new WeakIdentityLru<RichText, EmptyBlocks>(CACHE_BYTES, CACHE_DOCUMENTS);

    private directory(text: RichText): EmptyBlocks {
        const cached = this.cache.get(text);
        if (cached) return cached;
        const directory = new EmptyBlocks();
        this.cache.set(text, directory, 512);
        return directory;
    }
    has(text: RichText, index: number): boolean { return this.directory(text).has(index); }
    next(text: RichText, index: number, direction: -1 | 1): number { return this.directory(text).next(index, direction); }
    mark(text: RichText, index: number): void {
        const directory = this.directory(text), before = directory.size;
        directory.add(index);
        if (directory.size !== before) this.cache.set(text, directory, 512 + directory.size * 64);
    }
    inherit(before: RichText, after: RichText, first: number, removed: number, inserted: number): void {
        const previous = this.cache.get(before);
        // Do not turn a keystroke into a scan of thousands of fragmented intervals.
        if (!previous || previous.size > 512) return;
        const next = previous.splice(first, removed, inserted);
        if (next.size) this.cache.set(after, next, 512 + next.size * 64);
    }
    clear(): void { this.cache.clear(); }
}
