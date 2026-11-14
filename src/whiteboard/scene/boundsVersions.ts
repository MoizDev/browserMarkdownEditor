import type { NodeId } from '../model/ids';
import { validBox } from './bounds';
import type { Box } from './bounds';
import type { SceneBounds } from './types';

// Provenance: scene snapshot revision and geometry bounds contracts; independent
// persistent overlay design, no third-party source.
type Value = Readonly<{ quality: SceneBounds['quality']; ink: Box | null; selectable: Box | null }>;
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
    constructor(initialRevision: number) {
        revision(initialRevision);
        this.current = new BoundsView({ prior: null, values: new Map() }, initialRevision, 0);
    }
    update(nextRevision: number, delta: ReadonlyMap<NodeId, SceneBounds | null>): void {
        revision(nextRevision);
        const old = this.current;
        if (nextRevision < old.revision) throw new RangeError('Scene bounds revision cannot go backwards');
        const values = new Map<NodeId, Value | null>();
        let size = old.size;
        for (const [id, value] of delta) {
            const had = old.has(id);
            if (value === null) { if (had) size--; values.set(id, null); }
            else { if (!had) size++; values.set(id, copyValue(value)); }
        }
        this.current = new BoundsView(values.size ? { prior: old.root, values } : old.root, nextRevision, size);
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
