import type { Rect } from '../../platform/render';
import { intersects } from './coverage';

export class PdfTileCache<T extends { readonly used: number }> implements Iterable<[string, T]> {
    private readonly entries = new Map<string, T>();

    get(key: string): T | undefined { return this.entries.get(key); }
    set(key: string, entry: T): void { this.entries.set(key, entry); }
    delete(key: string): boolean { return this.entries.delete(key); }
    values(): IterableIterator<T> { return this.entries.values(); }
    [Symbol.iterator](): IterableIterator<[string, T]> { return this.entries[Symbol.iterator](); }

    evictable(desired: ReadonlySet<string>, viewport: Readonly<Rect>,
        bounds: (entry: T) => Readonly<Rect>, ready: (entry: T) => boolean): Array<[string, T]> {
        return [...this.entries].filter(([key, entry]) => ready(entry) && !desired.has(key) &&
            !intersects(bounds(entry), viewport)).sort((a, b) => a[1].used - b[1].used);
    }
}
