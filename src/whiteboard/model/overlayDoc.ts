import type { NodeSetOp } from '../change/ops';
import { boardPageStack } from './pages';
import { copyProjectedValue } from '../geom/projectedNodes';
import type { BoardDoc } from './doc';
import { nodeMediaForApply } from './applyOnly';
import type { NodeId, ParentId, SheetId } from './ids';
import type { MediaEntry, MediaId } from './media';
import { attachedTargets, type Node } from './nodes';
import { compareOrder } from './orderKey';
import { yieldToHost } from '../../platform/yieldToHost';

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
        for (const target of attachedTargets(node)) add(attached, target, node.id);
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

class ChangedSet<T> implements ReadonlySet<T> {
    readonly [Symbol.toStringTag] = 'ChangedSet';
    constructor(private readonly base: ReadonlySet<T>, private readonly added: ReadonlySet<T>, private readonly removed: ReadonlySet<T>,
        readonly size: number) {}
    has(value: T): boolean { return this.added.has(value) || (!this.removed.has(value) && this.base.has(value)); }
    *values(): SetIterator<T> { for (const value of this.base) if (!this.removed.has(value) || this.added.has(value)) yield value;
        for (const value of this.added) if (!this.base.has(value)) yield value; }
    keys(): SetIterator<T> { return this.values(); }
    *entries(): SetIterator<[T, T]> { for (const value of this.values()) yield [value, value]; }
    [Symbol.iterator](): SetIterator<T> { return this.values(); }
    forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
        for (const value of this.values()) callback.call(thisArg, value, value, this);
    }
}
function replacedChildren(base: readonly Node[], replacements: ReadonlyMap<NodeId, Node>): readonly Node[] {
    return new Proxy([] as Node[], {
        get(target, key, receiver) {
            if (key === 'length') return base.length;
            if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
                const node = base[Number(key)]; return node ? replacements.get(node.id) ?? node : undefined;
            }
            return Reflect.get(target, key, receiver);
        },
        has(target, key) {
            if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return Number(key) < base.length;
            return Reflect.has(target, key);
        },
        set() { throw new TypeError('Candidate child arrays are immutable'); },
        deleteProperty() { throw new TypeError('Candidate child arrays are immutable'); },
        defineProperty() { throw new TypeError('Candidate child arrays are immutable'); },
    });
}
type SetChanges<K> = { readonly added: Map<K, Set<NodeId>>; readonly removed: Map<K, Set<NodeId>> };
async function changedSets<K>(base: ReadonlyMap<K, ReadonlySet<NodeId>>, changes: SetChanges<K>,
    tick: () => Promise<void>, due: () => boolean): Promise<ReadonlyMap<K, ReadonlySet<NodeId>>> {
    const keys = new Set<K>();
    for (const key of changes.added.keys()) { keys.add(key); if (due()) await tick(); }
    for (const key of changes.removed.keys()) { keys.add(key); if (due()) await tick(); }
    const combined = new Map<K, ReadonlySet<NodeId>>(), removed = new Set<K>();
    for (const key of keys) {
        const previous = base.get(key) ?? new Set<NodeId>(), added = changes.added.get(key) ?? new Set<NodeId>(), deleted = changes.removed.get(key) ?? new Set<NodeId>();
        let size = previous.size;
        for (const value of deleted) { if (previous.has(value) && !added.has(value)) size--; if (due()) await tick(); }
        for (const value of added) { if (!previous.has(value)) size++; if (due()) await tick(); }
        if (size) combined.set(key, new ChangedSet(previous, added, deleted, size)); else removed.add(key);
        if (due()) await tick();
    }
    return new AddedMap(base, combined, removed);
}
export interface BoardGeometryProjectionOptions {
    readonly signal: AbortSignal;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}

export async function projectBoardGeometrySets(base: BoardDoc, ops: readonly NodeSetOp[], options: BoardGeometryProjectionOptions): Promise<BoardDoc> {
    if (typeof options.current !== 'function') throw new TypeError('Geometry projection requires a base lifetime fence');
    const signal = options.signal, revision = base.rev, host = base.host, cooperate = options.cooperate ?? yieldToHost;
    const original = new Map<NodeId, Readonly<Node>>(), replacements = new Map<NodeId, Node>(), childSources = new Map<ParentId, readonly Node[] | undefined>();
    const pageSources = new Map<number, ReadonlySet<NodeId> | undefined>(), attachmentSources = new Map<NodeId, ReadonlySet<NodeId> | undefined>();
    let work = 0, started = performance.now();
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || base.rev !== revision || base.host !== host) throw new DOMException('Geometry projection source changed', 'AbortError');
    };
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    check();
    for (const op of ops) {
        check();
        if (!op || op.t !== 'set') throw new TypeError('Geometry projection accepts node set operations only');
        const source = base.nodes.get(op.id);
        if (!source || source.kind === 'opaque') throw new Error(`Projected node is missing or opaque: ${op.id}`);
        const before = original.get(op.id);
        if (before && before !== source) throw new DOMException('Geometry projection node changed', 'AbortError');
        original.set(op.id, source);
        const prior = replacements.get(op.id) ?? source;
        if (!Object.hasOwn(prior, op.key)) throw new Error(`Node kind ${source.kind} has no ${op.key} property`);
        const value = await copyProjectedValue(op, tick, due); check();
        if (base.nodes.get(op.id) !== source) throw new DOMException('Geometry projection node changed', 'AbortError');
        replacements.set(op.id, { ...prior, [op.key]: value } as Node);
        if (due()) await tick();
    }
    const childChanges = new Map<ParentId, readonly Node[]>();
    const pageChanges: SetChanges<number> = { added: new Map(), removed: new Map() };
    const attachmentChanges: SetChanges<NodeId> = { added: new Map(), removed: new Map() };
    const stack = boardPageStack(host);
    for (const [id, value] of replacements) {
        const old = original.get(id)!;
        const node = Object.freeze(value); replacements.set(id, node);
        if (!childSources.has(node.parent)) {
            const children = base.children.get(node.parent); childSources.set(node.parent, children);
            childChanges.set(node.parent, replacedChildren(children ?? [], replacements));
        }
        if (node.page !== old.page) {
            const root = base.sheets.has(node.parent as SheetId);
            if (base.kind === 'whiteboard' || !root) {
                if (node.page !== -1) throw new RangeError('Projected node has invalid page ownership');
            } else {
                if (!stack || node.page < 0 || node.page >= stack.rects.length) throw new RangeError('Projected page is unavailable');
                if (!pageSources.has(old.page)) pageSources.set(old.page, base.byPage.get(old.page));
                if (!pageSources.has(node.page)) pageSources.set(node.page, base.byPage.get(node.page));
                add(pageChanges.removed, old.page, id); add(pageChanges.added, node.page, id);
            }
        }
        if (old.kind === 'connector' || old.kind === 'polyline') {
            const previous = new Set(attachedTargets(old)), next = new Set(attachedTargets(node));
            for (const target of previous) if (!next.has(target)) {
                if (!attachmentSources.has(target)) attachmentSources.set(target, base.attachedTo.get(target)); add(attachmentChanges.removed, target, id);
            }
            for (const target of next) if (!previous.has(target)) {
                if (!attachmentSources.has(target)) attachmentSources.set(target, base.attachedTo.get(target)); add(attachmentChanges.added, target, id);
            }
        }
        if (due()) await tick();
    }
    for (const [id, node] of original) { if (base.nodes.get(id) !== node) throw new DOMException('Geometry projection node changed', 'AbortError'); if (due()) await tick(); }
    for (const [id, children] of childSources) { if (base.children.get(id) !== children) throw new DOMException('Geometry projection children changed', 'AbortError'); if (due()) await tick(); }
    for (const [page, values] of pageSources) { if (base.byPage.get(page) !== values) throw new DOMException('Geometry projection page index changed', 'AbortError'); if (due()) await tick(); }
    for (const [id, values] of attachmentSources) { if (base.attachedTo.get(id) !== values) throw new DOMException('Geometry projection attachment index changed', 'AbortError'); if (due()) await tick(); }
    check();
    const byPage = await changedSets(base.byPage, pageChanges, tick, due); check();
    const attachedTo = await changedSets(base.attachedTo, attachmentChanges, tick, due); check();
    return { ...base, nodes: new AddedMap(base.nodes, replacements), children: new AddedMap(base.children, childChanges), byPage, attachedTo };
}


