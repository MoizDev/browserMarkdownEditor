import type { Rect } from '../../platform/render';
import { intersects } from './coverage';

/** Entries retain their own leases and destructors in the layer; this index never pretends that
 * removing a key has freed a pending worker allocation (design §6.3:644–646).
 */
export class PdfTileCache<T extends { readonly used: number }> implements Iterable<[string, T]> {
    private readonly entries = new Map<string, T>();

    get(key: string): T | undefined { return this.entries.get(key); }
    set(key: string, entry: T): void { this.entries.set(key, entry); }
    delete(key: string): boolean { return this.entries.delete(key); }
    values(): IterableIterator<T> { return this.entries.values(); }
    [Symbol.iterator](): IterableIterator<[string, T]> { return this.entries[Symbol.iterator](); }

    /** A visible provider remains until replacement pixels exist; only off-window stand-ins are evictable. */
    evictable(desired: ReadonlySet<string>, viewport: Readonly<Rect>,
        bounds: (entry: T) => Readonly<Rect>, ready: (entry: T) => boolean): Array<[string, T]> {
        return [...this.entries].filter(([key, entry]) => ready(entry) && !desired.has(key) &&
            !intersects(bounds(entry), viewport)).sort((a, b) => a[1].used - b[1].used);
    }
}
