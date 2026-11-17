import type { Rect } from '../../platform/types';
import type { NodeId } from '../model/ids';
import { BoundsQuality, validBox } from './bounds';
import type { Box } from './bounds';
import type { SceneBounds } from './types';

// Provenance: scene snapshot revision and geometry bounds contracts; independent
// persistent overlay design, no third-party source.
type Value = Readonly<{ quality: SceneBounds['quality']; ink: Box | null; selectable: Box | null }>;
/** One published revision's changes. `nodes` holds every node whose bounds or ordering inputs may have
 * moved, with the value it had before this revision and the value after. `null` means absent. */
export interface BoundsRevisionChange {
    readonly revision: number;
    /** A sheet or page changed: every region of this revision must be treated as unknown. */
    readonly structural: boolean;
    readonly nodes: ReadonlyMap<NodeId, { readonly before: Value | null; readonly after: Value | null }>;
}
/** History is bounded by revisions and by the node entries it retains; older revisions are not reconstructed. */
const HISTORY_REVISIONS = 512, HISTORY_NODES = 65_536;
/** Where pixels may have changed between two revisions: `full` means the span cannot be bounded, so
 * every region is unknown; otherwise only the listed world rectangles (ink, old and new) changed. */
export type RegionChanges = { readonly full: true } | { readonly full: false; readonly regions: readonly Rect[] };
export const FULL_REGION_CHANGES: RegionChanges = Object.freeze({ full: true });
/** Appends the ink rectangle of a settled value. Pending, cold or inkless values are unknown. */
function appendInk(value: Value, out: Rect[]): boolean {
    if (value.quality === BoundsQuality.Pending || value.quality === BoundsQuality.ColdLayout || !value.ink) return false;
    const [x0, y0, x1, y1] = value.ink;
    out.push(Object.freeze({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
    return true;
}
/** Old and new ink of every node a span touched. A dirty node whose box is unchanged still counts,
 * because a paint-only edit changes pixels inside an unchanged box. */
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
type Layer = { readonly prior: Layer | null; readonly values: ReadonlyMap<NodeId, Value | null> };
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

/** Updates are touched-only; every view stamps its own revision without rewriting older values. */
export class BoundsVersions {
    private current: BoundsView;
    private readonly history: BoundsRevisionChange[] = [];
    private retainedNodes = 0;
    /** Revisions at or below this one have been dropped from `history`. */
    private historyFloor = -1;
    constructor(initialRevision: number) {
        revision(initialRevision);
        this.current = new BoundsView({ prior: null, values: new Map() }, initialRevision, 0);
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
        // Dirty ids whose bounds are unchanged (a reorder, say) still name a region the caches must see.
        const nodes = new Map<NodeId, { before: Value | null; after: Value | null }>();
        const note = (id: NodeId) => {
            if (nodes.has(id)) return;
            const before = find(old.root, id) ?? null;
            const after = values.has(id) ? values.get(id) ?? null : before;
            nodes.set(id, { before, after });
        };
        for (const id of values.keys()) note(id);
        if (scope?.ids) for (const id of scope.ids) { note(id); if ((++count & 255) === 0) yield; }
        if (this.current !== old) throw new Error('Stale scene bounds publication');
        this.current = new BoundsView(values.size ? { prior: old.root, values } : old.root, nextRevision, size);
        this.history.push({ revision: nextRevision, structural: scope?.structural ?? false, nodes });
        this.retainedNodes += nodes.size;
        while (this.history.length > HISTORY_REVISIONS || this.retainedNodes > HISTORY_NODES) {
            const dropped = this.history.shift()!;
            this.retainedNodes -= dropped.nodes.size; this.historyFloor = dropped.revision;
        }
    }
    changedRegionsSince(from: number, to: number): RegionChanges { return regionChanges(this.changesSince(from, to)); }
    /** Every node a publication in (from, to] touched, or null when that span is not retained or a structural change makes every
     * node unknown. A dirty node whose box is unchanged is still named (a paint-only edit changes its pixels). */
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
    /** Every published change in (from, to], in order, or null when that span is not fully retained. */
    changesSince(from: number, to: number): readonly BoundsRevisionChange[] | null {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || from < this.historyFloor) return null;
        const newest = this.history.length ? this.history[this.history.length - 1].revision : this.historyFloor;
        if (newest < to) return null;
        return this.history.filter(change => change.revision > from && change.revision <= to);
    }
    pin(): ReadonlyMap<NodeId, SceneBounds> { return this.current; }
    /** Compaction is cooperative and never changes a previously pinned root. */
    async compact(signal?: AbortSignal, cooperate?: () => Promise<void>): Promise<ReadonlyMap<NodeId, SceneBounds>> {
        const pinned = this.current, seen = new Set<NodeId>(), values = new Map<NodeId, Value>();
        let count = 0, start = performance.now();
        const check = () => { if (signal?.aborted) throw new DOMException('Scene bounds compaction cancelled', 'AbortError'); };
        const tick = async () => {
            check(); await (cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            check(); count = 0; start = performance.now();
        };
        await tick();
        for (let layer: Layer | null = pinned.root; layer; layer = layer.prior) {
            for (const [id, value] of layer.values) {
                if (++count >= 256 || performance.now() - start >= 3) await tick();
                if (seen.has(id)) continue;
                seen.add(id); if (value !== null) values.set(id, value);
            }
        }
        check();
        const result = new BoundsView({ prior: null, values }, pinned.revision, values.size);
        if (this.current === pinned) this.current = result;
        return result;
    }
}
