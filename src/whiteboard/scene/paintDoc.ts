import { sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { MediaId } from '../model/media';
import { attachedTargets, type Node } from '../model/nodes';
import type { SceneRecordPin } from './recordStore';
import type { SceneMetadata } from './snapshotDoc';

type Check = () => void;

class CheckedSet<T> implements ReadonlySet<T> {
    readonly [Symbol.toStringTag] = 'CheckedSet';
    constructor(private readonly data: ReadonlySet<T>, private readonly check: Check) {}
    get size(): number { this.check(); return this.data.size; }
    has(value: T): boolean { this.check(); return this.data.has(value); }
    *values(): SetIterator<T> { this.check(); for (const value of this.data) { this.check(); yield value; } this.check(); }
    keys(): SetIterator<T> { return this.values(); }
    *entries(): SetIterator<[T, T]> { for (const value of this.values()) yield [value, value]; }
    [Symbol.iterator](): SetIterator<T> { return this.values(); }
    forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
        this.check(); for (const value of this.values()) callback.call(thisArg, value, value, this);
    }
}

class CheckedMap<K, V> implements ReadonlyMap<K, V> {
    readonly [Symbol.toStringTag] = 'CheckedMap';
    constructor(private readonly check: Check, private readonly lookup: (key: K) => V | undefined,
        private readonly all: () => Iterable<readonly [K, V]>, private readonly count?: () => number) {}
    get size(): number { this.check(); if (this.count) return this.count(); let count = 0; for (const _ of this.entries()) count++; return count; }
    get(key: K): V | undefined { this.check(); return this.lookup(key); }
    has(key: K): boolean { this.check(); return this.lookup(key) !== undefined; }
    *entries(): MapIterator<[K, V]> { this.check(); for (const [key, value] of this.all()) { this.check(); yield [key, value]; } this.check(); }
    *keys(): MapIterator<K> { for (const [key] of this.entries()) yield key; }
    *values(): MapIterator<V> { for (const [, value] of this.entries()) yield value; }
    [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
        this.check(); for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }
}

function arrayIndex(property: PropertyKey): number | undefined {
    if (typeof property !== 'string' || !/^(0|[1-9]\d*)$/.test(property)) return undefined;
    const index = Number(property);
    return Number.isSafeInteger(index) && index < 0xffffffff ? index : undefined;
}
function childArray(records: SceneRecordPin, parent: ParentId, check: Check): readonly Node[] {
    check();
    const count = records.childCount(parent), target: Node[] = [];
    const deny = () => { throw new TypeError('Pinned children are read-only'); };
    return new Proxy(target, {
        get(array, property, receiver) {
            check();
            if (property === 'length') return count;
            if (property === Symbol.iterator) return function* () {
                check(); for (const node of records.children(parent)) { check(); yield node; } check();
            };
            const index = arrayIndex(property);
            return index === undefined ? Reflect.get(array, property, receiver) : index < count ? records.childAt(parent, index) : undefined;
        },
        has(array, property) { check(); const index = arrayIndex(property); return index === undefined ? Reflect.has(array, property) : index < count; },
        ownKeys() { check(); const keys: string[] = []; for (let i = 0; i < count; i++) keys.push(String(i)); keys.push('length'); return keys; },
        getOwnPropertyDescriptor(array, property) {
            check(); const index = arrayIndex(property);
            if (property === 'length') return { value: count, writable: true, enumerable: false, configurable: false };
            if (index === undefined) return Reflect.getOwnPropertyDescriptor(array, property);
            if (index >= count) return undefined;
            return { value: records.childAt(parent, index), writable: false, enumerable: true, configurable: true };
        },
        set: deny, defineProperty: deny, deleteProperty: deny, setPrototypeOf: deny, preventExtensions: deny,
        getPrototypeOf(array) { check(); return Reflect.getPrototypeOf(array); },
        isExtensible(array) { check(); return Reflect.isExtensible(array); },
    });
}

/** Secondary indexes are deliberately lazy: an explicit get scans pinned rows once per key;
 * enumerating a whole index builds it. This fallback is not a W-1M latency guarantee. */
function lazyIndex<K>(records: SceneRecordPin, check: Check, keysOf: (node: Node) => readonly K[]): ReadonlyMap<K, ReadonlySet<NodeId>> {
    const cache = new Map<K, ReadonlySet<NodeId> | undefined>();
    let all: Map<K, ReadonlySet<NodeId>> | undefined;
    const lookup = (key: K): ReadonlySet<NodeId> | undefined => {
        check();
        if (cache.has(key)) return cache.get(key);
        const values = new Set<NodeId>();
        for (const node of records.values()) { check(); if (keysOf(node).includes(key)) values.add(node.id); }
        const value = values.size ? new CheckedSet(values, check) : undefined;
        cache.set(key, value); return value;
    };
    const entries = function* (): IterableIterator<readonly [K, ReadonlySet<NodeId>]> {
        check();
        if (!all) {
            const built = new Map<K, Set<NodeId>>();
            for (const node of records.values()) {
                check();
                for (const key of keysOf(node)) {
                    let set = built.get(key); if (!set) { set = new Set(); built.set(key, set); }
                    set.add(node.id);
                }
            }
            const result = new Map<K, ReadonlySet<NodeId>>();
            for (const [key, values] of built) {
                check();
                const value = cache.has(key) ? cache.get(key)! : new CheckedSet(values, check);
                cache.set(key, value); result.set(key, value);
            }
            all = result;
        }
        for (const entry of all) { check(); yield entry; }
    };
    return new CheckedMap(check, lookup, entries);
}

/** Immutable read facade over one pinned record tree; it owns no model session or node copies. */
export function createPinnedPaintDoc(records: SceneRecordPin, metadata: SceneMetadata, revision: number, check: Check): BoardDoc {
    check();
    if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Invalid pinned paint revision');
    const nodes = new CheckedMap<NodeId, Node>(check, id => records.get(id), function* () {
        for (const node of records.values()) { check(); yield [node.id, node] as const; }
    }, () => records.nodeCount);
    const arrays = new Map<ParentId, readonly Node[]>();
    const children: ReadonlyMap<ParentId, readonly Node[]> = new CheckedMap<ParentId, readonly Node[]>(check, parent => {
        if (!records.childCount(parent)) return undefined;
        let result = arrays.get(parent);
        if (!result) { result = childArray(records, parent, check); arrays.set(parent, result); }
        return result;
    }, function* (): IterableIterator<readonly [ParentId, readonly Node[]]> {
        const seen = new Set<ParentId>();
        for (const node of records.values()) {
            check(); if (seen.has(node.parent)) continue;
            seen.add(node.parent); yield [node.parent, children.get(node.parent)!] as const;
        }
    });
    const bySheet = lazyIndex<SheetId>(records, check, node => { const sheet = sheetOf(doc, node.id); return sheet === undefined ? [] : [sheet]; });
    const byPage = lazyIndex<number>(records, check, node => metadata.kind !== 'whiteboard' && metadata.sheets.has(node.parent as SheetId) ? [node.page] : []);
    const attachedTo = lazyIndex<NodeId>(records, check, attachedTargets);
    const mediaRefs = lazyIndex<MediaId>(records, check, node => {
        if ((node.kind === 'picture' || node.kind === 'clip') && node.media) return [node.media];
        if (node.kind === 'linkcard' && node.preview) return [node.preview.image, node.preview.favicon].filter((id): id is MediaId => !!id);
        return [];
    });
    const doc: BoardDoc = Object.freeze({
        get kind() { check(); return metadata.kind; }, get sheets() { check(); return metadata.sheets; },
        get media() { check(); return metadata.media; }, get sheetOrder() { check(); return metadata.sheetOrder; },
        get ui() { check(); return metadata.ui; }, get view() { check(); return metadata.view; },
        get host() { check(); return metadata.host; }, get preserved() { check(); return metadata.preserved; },
        get preservedMediaRefs() { check(); return metadata.preservedMediaRefs; },
        get nodes() { check(); return nodes; }, get children() { check(); return children; },
        get bySheet() { check(); return bySheet; }, get byPage() { check(); return byPage; },
        get attachedTo() { check(); return attachedTo; }, get mediaRefs() { check(); return mediaRefs; },
        get rev() { check(); return revision; },
    });
    return doc;
}
