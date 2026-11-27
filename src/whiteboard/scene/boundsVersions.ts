import type { Rect } from '../../platform/types';
import type { NodeId } from '../model/ids';
import { BoundsQuality, validBox } from './bounds';
import type { Box } from './bounds';
import type { SceneBounds } from './types';

type Value = Readonly<{ quality: SceneBounds['quality']; ink: Box | null; selectable: Box | null }>;
export interface BoundsRevisionChange {
    readonly revision: number;
    readonly structural: boolean;
    readonly nodes: ReadonlyMap<NodeId, { readonly before: Value | null; readonly after: Value | null }>;
}
const HISTORY_REVISIONS = 512, HISTORY_NODES = 65_536;
export type RegionChanges = { readonly full: true } | { readonly full: false; readonly regions: readonly Rect[] };
export const FULL_REGION_CHANGES: RegionChanges = Object.freeze({ full: true });
function appendInk(value: Value, out: Rect[]): boolean {
    if (value.quality === BoundsQuality.Pending || value.quality === BoundsQuality.ColdLayout || !value.ink) return false;
    const [x0, y0, x1, y1] = value.ink;
    out.push(Object.freeze({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
    return true;
}
export function regionChanges(changes: readonly BoundsRevisionChange[] | null): RegionChanges {
    if (!changes) return FULL_REGION_CHANGES;
    const regions: Rect[] = [];
    for (const change of changes) {
        if (change.structural) return FULL_REGION_CHANGES;
        for (const { before, after } of change.nodes.values()) {
            if (before && !appendInk(before, regions)) return FULL_REGION_CHANGES;
            if (after && !appendInk(after, regions)) return FULL_REGION_CHANGES;
        }
    }
    return { full: false, regions };
}
type Layer = { readonly prior: Layer | null; readonly values: ReadonlyMap<NodeId, Value | null>; readonly depth: number };
/** A lookup walks the layers newest first, so their number is bounded: past this depth a publication folds every layer into
 * one. Unbounded, each publication added a layer for the board's life (nothing compacted them), and opening a converted
 * 1 MB board of ~2,000 text shapes spent 11.1 s of its 17.5 s "Loading drawing…" walking that chain (CfT 157, M4 Pro). */
const MAX_LAYER_DEPTH = 16;
function revision(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid scene bounds revision');
}
function copyBox(box: Box | null): Box | null {
    if (box === null) return null;
    if (!Array.isArray(box) || box.length !== 4 || !validBox(box)) throw new TypeError('Invalid scene bounds box');
    return Object.freeze([box[0], box[1], box[2], box[3]] as const);
}
function copyValue(value: SceneBounds): Value {
    if (!Number.isInteger(value.quality) || value.quality < 0 || value.quality > 3) throw new TypeError('Invalid scene bounds quality');
    return Object.freeze({ quality: value.quality, ink: copyBox(value.ink), selectable: copyBox(value.selectable) });
}
function find(root: Layer, id: NodeId): Value | undefined {
    for (let layer: Layer | null = root; layer; layer = layer.prior) {
        if (layer.values.has(id)) return layer.values.get(id) ?? undefined;
    }
    return undefined;
}
class BoundsView implements ReadonlyMap<NodeId, SceneBounds> {
    readonly [Symbol.toStringTag] = 'SceneBoundsView';
    constructor(readonly root: Layer, readonly revision: number, readonly size: number) {}
    get(id: NodeId): SceneBounds | undefined {
        const value = find(this.root, id);
        return value === undefined ? undefined : Object.freeze({ ...value, revision: this.revision });
    }
    has(id: NodeId): boolean { return find(this.root, id) !== undefined; }
    *entries(): MapIterator<[NodeId, SceneBounds]> {
        const seen = new Set<NodeId>();
        for (let layer: Layer | null = this.root; layer; layer = layer.prior) {
            for (const [id, value] of layer.values) {
                if (seen.has(id)) continue;
                seen.add(id);
                if (value !== null) yield [id, Object.freeze({ ...value, revision: this.revision })];
            }
        }
    }
    *keys(): MapIterator<NodeId> { for (const [id] of this.entries()) yield id; }
    *values(): MapIterator<SceneBounds> { for (const [, value] of this.entries()) yield value; }
    [Symbol.iterator](): MapIterator<[NodeId, SceneBounds]> { return this.entries(); }
    forEach(callback: (value: SceneBounds, key: NodeId, map: ReadonlyMap<NodeId, SceneBounds>) => void, thisArg?: unknown): void {
        for (const [id, value] of this) callback.call(thisArg, value, id, this);
    }
}

export class BoundsVersions {
    private current: BoundsView;
    private readonly history: BoundsRevisionChange[] = [];
    private retainedNodes = 0;
    private historyFloor = -1;
    constructor(initialRevision: number) {
        revision(initialRevision);
        this.current = new BoundsView({ prior: null, values: new Map(), depth: 0 }, initialRevision, 0);
        this.historyFloor = initialRevision;
    }
    update(nextRevision: number, delta: ReadonlyMap<NodeId, SceneBounds | null>, scope?: { ids?: Iterable<NodeId>; structural?: boolean }): void {
        for (const _ of this.updateSteps(nextRevision, delta, scope)) { /* synchronous callers finish the same publication */ }
    }
    *updateSteps(nextRevision: number, delta: ReadonlyMap<NodeId, SceneBounds | null>, scope?: { ids?: Iterable<NodeId>; structural?: boolean }): Generator<void, void> {
        revision(nextRevision);
        const old = this.current;
        if (nextRevision < old.revision) throw new RangeError('Scene bounds revision cannot go backwards');
        const values = new Map<NodeId, Value | null>();
        let size = old.size, count = 0;
        for (const [id, value] of delta) {
            const had = old.has(id);
            if (value === null) { if (had) size--; values.set(id, null); }
            else { if (!had) size++; values.set(id, copyValue(value)); }
            if ((++count & 255) === 0) yield;
        }
        const nodes = new Map<NodeId, { before: Value | null; after: Value | null }>();
        const note = (id: NodeId) => {
            if (nodes.has(id)) return;
            const before = find(old.root, id) ?? null;
            const after = values.has(id) ? values.get(id) ?? null : before;
            nodes.set(id, { before, after });
        };
        for (const id of values.keys()) note(id);
        if (scope?.ids) for (const id of scope.ids) { note(id); if ((++count & 255) === 0) yield; }
        let root: Layer = values.size ? { prior: old.root, values, depth: old.root.depth + 1 } : old.root;
        if (root.depth > MAX_LAYER_DEPTH) {
            const folded = new Map<NodeId, Value>(), seen = new Set<NodeId>();
            for (let layer: Layer | null = root; layer; layer = layer.prior) {
                for (const [id, value] of layer.values) {
                    if (seen.has(id)) continue;
                    seen.add(id); if (value !== null) folded.set(id, value);
                    if ((++count & 255) === 0) yield;
                }
            }
            root = { prior: null, values: folded, depth: 0 };
        }
        if (this.current !== old) throw new Error('Stale scene bounds publication');
        this.current = new BoundsView(root, nextRevision, size);
        this.history.push({ revision: nextRevision, structural: scope?.structural ?? false, nodes });
        this.retainedNodes += nodes.size;
        while (this.history.length > HISTORY_REVISIONS || this.retainedNodes > HISTORY_NODES) {
            const dropped = this.history.shift()!;
            this.retainedNodes -= dropped.nodes.size; this.historyFloor = dropped.revision;
        }
    }
    changedRegionsSince(from: number, to: number): RegionChanges { return regionChanges(this.changesSince(from, to)); }
    changedNodesSince(from: number, to: number): ReadonlySet<NodeId> | null {
        const changes = this.changesSince(from, to);
        if (!changes) return null;
        const ids = new Set<NodeId>();
        for (const change of changes) {
            if (change.structural) return null;
            for (const id of change.nodes.keys()) ids.add(id);
        }
        return ids;
    }
    changesSince(from: number, to: number): readonly BoundsRevisionChange[] | null {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || from < this.historyFloor) return null;
        const newest = this.history.length ? this.history[this.history.length - 1].revision : this.historyFloor;
        if (newest < to) return null;
        return this.history.filter(change => change.revision > from && change.revision <= to);
    }
    pin(): ReadonlyMap<NodeId, SceneBounds> { return this.current; }
}
