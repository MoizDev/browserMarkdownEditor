import type { Misspelling } from './menu';

const ITEM_CACHE_BYTES = 256 * 1024;
const ITEM_CACHE_COUNT = 512;

function arrayIndex(key: PropertyKey, length: number): number | null {
    if (typeof key !== 'string' || !key.length) return null;
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key ? index : null;
}

/**
 * The spell worker can return hundreds of thousands of ranges. Keep the packed transfer and
 * materialize only the words that viewport painting, hit testing or the menu actually reads.
 * The array surface remains compatible with indexed reads, iteration and Array methods.
 */
export function packedMisspellings(text: string, ranges: Uint32Array): readonly Misspelling[] {
    const length = ranges.length / 2;
    const target = new Array<Misspelling>(length);
    const cache = new Map<number, Misspelling>();
    let bytes = 0;
    const size = (item: Misspelling) => 80 + item.word.length * 2;
    const itemAt = (index: number): Misspelling => {
        const previous = cache.get(index);
        if (previous) {
            cache.delete(index); cache.set(index, previous);
            return previous;
        }
        const from = ranges[index * 2], to = ranges[index * 2 + 1];
        const item = { from, to, word: text.slice(from, to) };
        const cost = size(item);
        if (cost <= ITEM_CACHE_BYTES) {
            while (cache.size >= ITEM_CACHE_COUNT || bytes + cost > ITEM_CACHE_BYTES) {
                const oldest = cache.keys().next().value as number | undefined;
                if (oldest === undefined) break;
                const removed = cache.get(oldest)!;
                cache.delete(oldest); bytes -= size(removed);
            }
            cache.set(index, item); bytes += cost;
        }
        return item;
    };
    return new Proxy(target, {
        get(array, key, receiver) {
            const index = arrayIndex(key, length);
            return index === null ? Reflect.get(array, key, receiver) : itemAt(index);
        },
        has(array, key) {
            return arrayIndex(key, length) !== null || Reflect.has(array, key);
        },
        getOwnPropertyDescriptor(array, key) {
            const index = arrayIndex(key, length);
            return index === null ? Reflect.getOwnPropertyDescriptor(array, key)
                : { configurable: true, enumerable: true, writable: false, value: itemAt(index) };
        },
        ownKeys(array) {
            const keys: string[] = [];
            for (let index = 0; index < length; index++) keys.push(String(index));
            return [...keys, ...Reflect.ownKeys(array)];
        },
        set() { return false; },
        defineProperty() { return false; },
        deleteProperty() { return false; },
        preventExtensions() { return false; },
    });
}
