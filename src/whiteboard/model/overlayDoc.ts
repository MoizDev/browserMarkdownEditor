import type { BoardDoc } from './doc';
import { nodeMediaForApply } from './applyOnly';
import type { NodeId, ParentId, SheetId } from './ids';
import type { MediaEntry, MediaId } from './media';
import type { Node } from './nodes';
import { compareOrder } from './orderKey';

// Provenance: staged geometry, ordered child indexes and immutable session
// contracts; independent addition-only read projection, no third-party source.
class AddedMap<K, V> implements ReadonlyMap<K, V> {
    readonly [Symbol.toStringTag] = 'AddedMap';
    constructor(private readonly base: ReadonlyMap<K, V>, private readonly extra: ReadonlyMap<K, V>, private readonly removed: ReadonlySet<K> = new Set()) {}
    get size(): number { let n = this.base.size; for (const key of this.removed) if (this.base.has(key)) n--; for (const key of this.extra.keys()) if (!this.base.has(key)) n++; return n; }
    has(key: K): boolean { return this.extra.has(key) || (!this.removed.has(key) && this.base.has(key)); }
    get(key: K): V | undefined { return this.extra.has(key) ? this.extra.get(key) : this.removed.has(key) ? undefined : this.base.get(key); }
    *entries(): MapIterator<[K, V]> { for (const [key, value] of this.base) if (!this.removed.has(key)) yield [key, this.extra.has(key) ? this.extra.get(key)! : value];
        for (const [key, value] of this.extra) if (!this.base.has(key)) yield [key, value]; }
    *keys(): MapIterator<K> { for (const [key] of this.entries()) yield key; }
    *values(): MapIterator<V> { for (const [, value] of this.entries()) yield value; }
    [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }
}
class AddedSet<T> implements ReadonlySet<T> {
    readonly [Symbol.toStringTag] = 'AddedSet';
    constructor(private readonly base: ReadonlySet<T>, private readonly extra: ReadonlySet<T>) {}
    get size(): number { let n = this.base.size; for (const value of this.extra) if (!this.base.has(value)) n++; return n; }
    has(value: T): boolean { return this.base.has(value) || this.extra.has(value); }
    *values(): SetIterator<T> { yield* this.base; for (const value of this.extra) if (!this.base.has(value)) yield value; }
    keys(): SetIterator<T> { return this.values(); }
    *entries(): SetIterator<[T, T]> { for (const value of this.values()) yield [value, value]; }
    [Symbol.iterator](): SetIterator<T> { return this.values(); }
    forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
        for (const value of this.values()) callback.call(thisArg, value, value, this);
    }
}
function concat<T>(base: readonly T[], added: readonly T[]): readonly T[] {
    const length = base.length + added.length;
    return new Proxy([] as T[], {
        get(target, key, receiver) {
            if (key === 'length') return length;
            if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
                const i = Number(key); return i < base.length ? base[i] : added[i - base.length];
            }
            return Reflect.get(target, key, receiver);
        },
        has(target, key) {
            if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return Number(key) < length;
            return Reflect.has(target, key);
        },
        set() { throw new TypeError('Candidate child arrays are immutable'); },
        deleteProperty() { throw new TypeError('Candidate child arrays are immutable'); },
        defineProperty() { throw new TypeError('Candidate child arrays are immutable'); },
    });
}
function add<K>(map: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    let values = map.get(key); if (!values) map.set(key, values = new Set()); values.add(id);
}
function sets<K>(base: ReadonlyMap<K, ReadonlySet<NodeId>>, delta: Map<K, Set<NodeId>>): ReadonlyMap<K, ReadonlySet<NodeId>> {
    const combined = new Map<K, ReadonlySet<NodeId>>();
    for (const [key, values] of delta) combined.set(key, new AddedSet(base.get(key) ?? new Set<NodeId>(), values));
    return new AddedMap(base, combined);
}
export function createAddedBoardDoc(base: BoardDoc, additions: readonly Node[], media: readonly MediaEntry[] = [],
    preservedMediaRefs: ReadonlyMap<MediaId, number> = new Map()): BoardDoc {
    const nodes = new Map<NodeId, Node>(), mediaMap = new Map<MediaId, MediaEntry>();
    for (const node of additions) {
        if (nodes.has(node.id) || base.nodes.has(node.id) || base.sheets.has(node.id as unknown as SheetId)) throw new Error('Candidate node id already exists');
        nodes.set(node.id, node);
    }
    for (const item of media) {
        if (mediaMap.has(item.id)) throw new Error('Duplicate candidate media id');
        mediaMap.set(item.id, item);
    }
    const childDeltas = new Map<ParentId, Node[]>(), attached = new Map<NodeId, Set<NodeId>>();
    const sheetDeltas = new Map<SheetId, Set<NodeId>>(), pageDeltas = new Map<number, Set<NodeId>>(), refs = new Map<MediaId, Set<NodeId>>();
    for (const node of nodes.values()) {
        let children = childDeltas.get(node.parent); if (!children) childDeltas.set(node.parent, children = []); children.push(node);
        let parent = node.parent, sheet: SheetId | undefined;
        for (let depth = 0; depth <= 64; depth++) {
            if (base.sheets.has(parent as SheetId)) { sheet = parent as SheetId; break; }
            const ancestor = nodes.get(parent as NodeId) ?? base.nodes.get(parent as NodeId);
            if (!ancestor) throw new Error('Candidate parent is missing');
            parent = ancestor.parent;
        }
        if (!sheet) throw new Error('Candidate ancestry is invalid');
        add(sheetDeltas, sheet, node.id);
        if (base.kind !== 'whiteboard' && base.sheets.has(node.parent as SheetId)) add(pageDeltas, node.page, node.id);
        if (node.kind === 'connector') for (const end of [node.start, node.end]) if (end.attach) add(attached, end.attach.target, node.id);
        for (const id of nodeMediaForApply(node)) add(refs, id, node.id);
    }
    const children = new Map<ParentId, readonly Node[]>();
    for (const [parent, list] of childDeltas) {
        list.sort(compareOrder);
        const existing = base.children.get(parent) ?? [];
        if (existing.length && list.length && compareOrder(existing[existing.length - 1], list[0]) >= 0) throw new Error('Candidate additions must follow existing child order');
        children.set(parent, concat(existing, Object.freeze(list)));
    }
    const preserved = new Map<MediaId, number>(), removed = new Set<MediaId>();
    for (const [id, count] of preservedMediaRefs) {
        const next = (base.preservedMediaRefs.get(id) ?? 0) + count;
        if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Invalid candidate preserved media count');
        if (next) preserved.set(id, next); else removed.add(id);
    }
    return { ...base, nodes: new AddedMap(base.nodes, nodes), media: new AddedMap(base.media, mediaMap),
        children: new AddedMap(base.children, children), attachedTo: sets(base.attachedTo, attached), bySheet: sets(base.bySheet, sheetDeltas),
        byPage: sets(base.byPage, pageDeltas), mediaRefs: sets(base.mediaRefs, refs), preservedMediaRefs: new AddedMap(base.preservedMediaRefs, preserved, removed) };
}
