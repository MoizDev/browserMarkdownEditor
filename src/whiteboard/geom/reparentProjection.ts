import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { compareOrder, type OrderKey } from '../model/orderKey';

export interface GeometryReparent {
    readonly id: NodeId;
    readonly parent: ParentId;
    readonly page: number;
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly order: OrderKey;
}

/** A sparse read-only replacement map; iteration sees the same replacement as get(). */
class ReplacementMap<K, V> implements ReadonlyMap<K, V> {
    readonly [Symbol.toStringTag] = 'ReplacementMap';
    constructor(private readonly base: ReadonlyMap<K, V>, private readonly replacements: ReadonlyMap<K, V>, private readonly removed: ReadonlySet<K> = new Set()) {}
    get size(): number {
        let result = this.base.size;
        for (const key of this.removed) if (this.base.has(key)) result--;
        for (const key of this.replacements.keys()) if (!this.base.has(key) || this.removed.has(key)) result++;
        return result;
    }
    get(key: K): V | undefined { return this.replacements.has(key) ? this.replacements.get(key) : this.removed.has(key) ? undefined : this.base.get(key); }
    has(key: K): boolean { return this.replacements.has(key) || (!this.removed.has(key) && this.base.has(key)); }
    *entries(): MapIterator<[K, V]> {
        for (const [key, value] of this.base) if (!this.removed.has(key)) yield [key, this.replacements.has(key) ? this.replacements.get(key)! : value];
        for (const [key, value] of this.replacements) if (!this.base.has(key) || this.removed.has(key)) yield [key, value];
    }
    *keys(): MapIterator<K> { for (const [key] of this.entries()) yield key; }
    *values(): MapIterator<V> { for (const [, value] of this.entries()) yield value; }
    [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }
}
class DeltaSet<T> implements ReadonlySet<T> {
    readonly [Symbol.toStringTag] = 'DeltaSet';
    constructor(private readonly base: ReadonlySet<T>, private readonly added: ReadonlySet<T>, private readonly removed: ReadonlySet<T>) {}
    get size(): number {
        let count = this.base.size;
        for (const value of this.removed) if (this.base.has(value) && !this.added.has(value)) count--;
        for (const value of this.added) if (!this.base.has(value)) count++;
        return count;
    }
    has(value: T): boolean { return this.added.has(value) || (!this.removed.has(value) && this.base.has(value)); }
    *values(): SetIterator<T> { for (const value of this.base) if (!this.removed.has(value) || this.added.has(value)) yield value;
        for (const value of this.added) if (!this.base.has(value)) yield value; }
    keys(): SetIterator<T> { return this.values(); }
    *entries(): SetIterator<[T, T]> { for (const value of this.values()) yield [value, value]; }
    [Symbol.iterator](): SetIterator<T> { return this.values(); }
    forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
        for (const value of this.values()) callback.call(thisArg, value, value, this);
    }
}

/** Project reparented roots without copying the vault or mutating the live child/page indexes. */
export async function projectGeometryReparents(base: BoardDoc, changes: readonly GeometryReparent[], options: {
    readonly signal: AbortSignal;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}): Promise<BoardDoc> {
    const { signal } = options, revision = base.rev, host = base.host;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let work = 0, started = performance.now();
    const check = () => { signal.throwIfAborted(); if (!options.current() || base.rev !== revision || base.host !== host) throw new DOMException('Reparent projection became stale', 'AbortError'); };
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    check();
    const replacements = new Map<NodeId, Node>(), originals = new Map<NodeId, Node>(), affected = new Set<ParentId>();
    for (const change of changes) {
        check(); const node = base.nodes.get(change.id);
        if (!node || node.kind === 'opaque' || replacements.has(change.id)) throw new Error('Invalid projected reparent root');
        if (![change.x, change.y, change.rotation, change.page].every(Number.isFinite) || !Number.isInteger(change.page)) throw new RangeError('Invalid projected reparent pose');
        originals.set(node.id, node); affected.add(node.parent); affected.add(change.parent);
        replacements.set(node.id, Object.freeze({ ...node, parent: change.parent, page: change.page, x: change.x, y: change.y,
            rotation: change.rotation, order: change.order }) as Node);
        if (due()) await tick();
    }
    const nodes = new ReplacementMap(base.nodes, replacements);
    // Reparenting stays within a sheet and cannot introduce a cycle.
    for (const [id, node] of replacements) {
        let parent = node.parent, sheet: SheetId | undefined;
        for (let depth = 0; depth <= 64; depth++) {
            if (base.sheets.has(parent as SheetId)) { sheet = parent as SheetId; break; }
            if (parent === id) throw new Error('Projected reparent cycle');
            const ancestor = nodes.get(parent as NodeId); if (!ancestor || (ancestor.kind !== 'frame' && ancestor.kind !== 'group')) throw new Error('Projected parent is unavailable');
            parent = ancestor.parent;
        }
        if (!sheet) throw new Error('Projected parent hierarchy exceeds its limit');
        let oldParent = originals.get(id)!.parent, oldSheet: SheetId | undefined;
        for (let depth = 0; depth <= 64; depth++) {
            if (base.sheets.has(oldParent as SheetId)) { oldSheet = oldParent as SheetId; break; }
            const ancestor = base.nodes.get(oldParent as NodeId); if (!ancestor) throw new Error('Original parent is unavailable'); oldParent = ancestor.parent;
        }
        if (oldSheet !== sheet) throw new Error('Projected reparent crosses sheets');
        if (due()) await tick();
    }
    const childChanges = new Map<ParentId, readonly Node[]>(), removedParents = new Set<ParentId>();
    const additions = new Map<ParentId, Node[]>();
    for (const node of replacements.values()) {
        if (originals.get(node.id)!.parent !== node.parent) {
            const list = additions.get(node.parent) ?? []; list.push(node); additions.set(node.parent, list);
        }
        if (due()) await tick();
    }
    for (const parent of affected) {
        const children: Node[] = [];
        for (const node of base.children.get(parent) ?? []) {
            const replacement = replacements.get(node.id);
            if (!replacement) children.push(node); else if (replacement.parent === parent) children.push(replacement);
            if (due()) await tick();
        }
        for (const node of additions.get(parent) ?? []) { children.push(node); if (due()) await tick(); }
        // Cooperative stable mergesort retains the model's exact paint-order tie break.
        let sorted = children, buffer = new Array<Node>(children.length);
        for (let width = 1; width < sorted.length; width *= 2) {
            for (let start = 0; start < sorted.length; start += 2 * width) {
                const middle = Math.min(start + width, sorted.length), end = Math.min(start + 2 * width, sorted.length);
                let left = start, right = middle;
                for (let out = start; out < end; out++) {
                    buffer[out] = left < middle && (right >= end || compareOrder(sorted[left], sorted[right]) <= 0) ? sorted[left++] : sorted[right++];
                    if (due()) await tick();
                }
            }
            [sorted, buffer] = [buffer, sorted];
        }
        if (sorted.length) childChanges.set(parent, Object.freeze(sorted)); else removedParents.add(parent);
        if (due()) await tick();
    }
    const pageChanges = new Map<number, { added: Set<NodeId>; removed: Set<NodeId> }>();
    const page = (index: number) => {
        let delta = pageChanges.get(index); if (!delta) { delta = { added: new Set(), removed: new Set() }; pageChanges.set(index, delta); }
        return delta;
    };
    for (const [id, node] of replacements) {
        const before = originals.get(id)!;
        if (base.sheets.has(before.parent as SheetId) && before.page >= 0) page(before.page).removed.add(id);
        if (base.sheets.has(node.parent as SheetId) && node.page >= 0) page(node.page).added.add(id);
        if (due()) await tick();
    }
    const pageValues = new Map<number, ReadonlySet<NodeId>>(), emptyPages = new Set<number>();
    for (const [index, delta] of pageChanges) {
        const view = new DeltaSet(base.byPage.get(index) ?? new Set<NodeId>(), delta.added, delta.removed);
        if (view.size) pageValues.set(index, view); else emptyPages.add(index);
        if (due()) await tick();
    }
    check();
    for (const [id, original] of originals) { if (base.nodes.get(id) !== original) throw new DOMException('Reparent source changed', 'AbortError'); if (due()) await tick(); }
    return { ...base, nodes: nodes as BoardDoc['nodes'], children: new ReplacementMap(base.children, childChanges, removedParents) as BoardDoc['children'],
        byPage: new ReplacementMap(base.byPage, pageValues, emptyPages) as BoardDoc['byPage'] };
}
