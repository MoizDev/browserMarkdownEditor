import { intersects, validBox } from './bounds';
import type { Box } from './bounds';
import { HybridIndex } from './index';

export type QueryStatus = 'pending' | 'complete' | 'stale' | 'cancelled';
export type QueryRequest =
    | Readonly<{ kind: 'box'; box: Box; order?: 'forward' | 'reverse' }>
    | Readonly<{ kind: 'point'; x: number; y: number; maxDistance?: number; order?: 'forward' | 'reverse' }>
    | Readonly<{ kind: 'strip'; axis: 'x' | 'y'; value: number; maxDistance?: number; order?: 'forward' | 'reverse' }>;
export interface SpatialQuerySource {
    readonly index: HybridIndex;
    readonly unbounded?: ReadonlySet<number>;
    /** Includes semantic/layout publication changes even when the document revision is unchanged. */
    epoch(): number;
    accepts(slot: number): boolean;
    /** Current conservative selectable/ink envelope, chosen by the source. Writes min/max. */
    bounds(slot: number, out: Float64Array): boolean;
    rank(slot: number): number;
}
export type NearestVisitor = (slot: number, generation: number) => number | undefined;

// Caller-owned output; length is provisional until the cursor returns COMPLETE. Never treat a
// capped prefix as the result of a marquee/delete/capture. Storage grows, it does not truncate.
export class QueryBuffer {
    slots = new Uint32Array(16);
    generations = new Uint32Array(16);
    ranks = new Float64Array(16);
    length = 0;
    reset(): void { this.length = 0; }
    push(slot: number, generation: number, rank: number): void {
        if (this.length === this.slots.length) {
            const capacity = this.length * 2;
            const slots = new Uint32Array(capacity); slots.set(this.slots); this.slots = slots;
            const generations = new Uint32Array(capacity); generations.set(this.generations); this.generations = generations;
            const ranks = new Float64Array(capacity); ranks.set(this.ranks); this.ranks = ranks;
        }
        const i = this.length++; this.slots[i] = slot; this.generations[i] = generation; this.ranks[i] = rank;
    }
    swap(a: number, b: number): void {
        let value = this.slots[a]; this.slots[a] = this.slots[b]; this.slots[b] = value;
        value = this.generations[a]; this.generations[a] = this.generations[b]; this.generations[b] = value;
        value = this.ranks[a]; this.ranks[a] = this.ranks[b]; this.ranks[b] = value;
    }
    get byteLength(): number { return this.slots.byteLength + this.generations.byteLength + this.ranks.byteLength; }
}

// Heap contains both trees, so nearest/strip walks share one conservative lower-bound frontier.
// Ties are NOT pruned: the narrow phase can still prefer a higher paint-order candidate.
class Frontier {
    nodes = new Uint32Array(32);
    dynamic = new Uint8Array(32);
    distances = new Float64Array(32);
    length = 0;
    node = 0;
    isDynamic = false;
    distance = 0;
    push(node: number, dynamic: boolean, distance: number): void {
        if (this.length === this.nodes.length) {
            const capacity = this.length * 2;
            const nodes = new Uint32Array(capacity); nodes.set(this.nodes); this.nodes = nodes;
            const kinds = new Uint8Array(capacity); kinds.set(this.dynamic); this.dynamic = kinds;
            const distances = new Float64Array(capacity); distances.set(this.distances); this.distances = distances;
        }
        let i = this.length++;
        while (i) {
            const parent = (i - 1) >>> 1;
            if (this.distances[parent] < distance || (this.distances[parent] === distance && this.nodes[parent] <= node)) break;
            this.nodes[i] = this.nodes[parent]; this.dynamic[i] = this.dynamic[parent]; this.distances[i] = this.distances[parent]; i = parent;
        }
        this.nodes[i] = node; this.dynamic[i] = Number(dynamic); this.distances[i] = distance;
    }
    pop(): void {
        this.node = this.nodes[0]; this.isDynamic = !!this.dynamic[0]; this.distance = this.distances[0];
        const last = --this.length;
        if (!last) return;
        const node = this.nodes[last], dynamic = this.dynamic[last], distance = this.distances[last];
        let i = 0;
        while (2 * i + 1 < last) {
            let child = 2 * i + 1;
            if (child + 1 < last && (this.distances[child + 1] < this.distances[child]
                || (this.distances[child + 1] === this.distances[child] && this.nodes[child + 1] < this.nodes[child]))) child++;
            if (distance < this.distances[child] || (distance === this.distances[child] && node <= this.nodes[child])) break;
            this.nodes[i] = this.nodes[child]; this.dynamic[i] = this.dynamic[child]; this.distances[i] = this.distances[child]; i = child;
        }
        this.nodes[i] = node; this.dynamic[i] = dynamic; this.distances[i] = distance;
    }
    get byteLength(): number { return this.nodes.byteLength + this.dynamic.byteLength + this.distances.byteLength; }
}

export class SpatialQuery {
    private source: SpatialQuerySource | undefined;
    private request: QueryRequest | undefined;
    private visitor: NearestVisitor | undefined;
    private state: QueryStatus = 'cancelled';
    private sceneEpoch = 0;
    private indexEpoch = 0;
    private readonly frontier = new Frontier();
    private readonly box = new Float64Array(4);
    private unbounded: Iterator<number> | undefined;
    private leased = false;
    private best = Infinity;
    private sortBuild = -1;
    private sortEnd = -1;
    private sorting = false;
    private stepping = false;
    constructor(readonly output = new QueryBuffer()) {}
    get status(): QueryStatus { return this.state; }
    get bestDistance(): number { return this.best; }
    get result(): QueryBuffer { if (this.state !== 'complete') throw new Error('Spatial result is not complete'); return this.output; }
    get byteLength(): number { return this.output.byteLength + this.frontier.byteLength + this.box.byteLength; }
    begin(source: SpatialQuerySource, request: QueryRequest, visitor?: NearestVisitor): this {
        if (this.stepping) throw new Error('Cannot restart a spatial query from its visitor');
        this.cancel();
        if (request.kind === 'box' ? !validBox(request.box) : request.kind === 'point'
            ? !Number.isFinite(request.x) || !Number.isFinite(request.y) : !Number.isFinite(request.value)) throw new RangeError('Invalid spatial query');
        const maximum = request.kind === 'box' ? Infinity : request.maxDistance ?? Infinity;
        if (Number.isNaN(maximum) || maximum < 0) throw new RangeError('Invalid nearest distance');
        source.index.acquireQuery(); this.leased = true;
        this.source = source; this.request = request; this.visitor = visitor;
        this.sceneEpoch = source.epoch(); this.indexEpoch = source.index.epoch; this.best = maximum;
        this.output.reset(); this.frontier.length = 0; this.sorting = false;
        this.unbounded = source.unbounded?.values(); this.state = 'pending';
        this.enqueue(source.index.packed.root, false); this.enqueue(source.index.edits.root, true);
        return this;
    }
    cancel(): void { this.finish('cancelled'); }
    private current(): boolean { return !!this.source && this.source.epoch() === this.sceneEpoch && this.source.index.epoch === this.indexEpoch; }
    private get cancelled(): boolean { return this.state === 'cancelled'; }
    private finish(state: QueryStatus): QueryStatus {
        if (this.leased) { this.source!.index.releaseQuery(); this.leased = false; }
        this.state = state; this.source = undefined; this.request = undefined; this.visitor = undefined; this.unbounded = undefined;
        this.frontier.length = 0;
        return state;
    }
    private lower(a: ArrayLike<number>, offset = 0): number {
        const q = this.request!;
        if (q.kind === 'box') return intersects(a, offset, q.box, 0) ? 0 : Infinity;
        if (q.kind === 'strip') {
            const axis = q.axis === 'x' ? 0 : 1;
            return Math.max(0, a[offset + axis] - q.value, q.value - a[offset + axis + 2]);
        }
        return Math.hypot(Math.max(0, a[offset] - q.x, q.x - a[offset + 2]), Math.max(0, a[offset + 1] - q.y, q.y - a[offset + 3]));
    }
    private enqueue(node: number, dynamic: boolean): void {
        if (node < 0) return;
        const tree = dynamic ? this.source!.index.edits : this.source!.index.packed;
        const distance = this.lower(tree.bounds, 4 * node);
        if (distance !== Infinity && distance <= this.best) this.frontier.push(node, dynamic, distance);
    }
    private candidate(slot: number, unknown: boolean): void {
        const source = this.source!;
        if (!source.index.alive(slot) || !source.accepts(slot)) return;
        if (!unknown && source.bounds(slot, this.box)) {
            const distance = this.lower(this.box);
            if (distance === Infinity || distance > this.best) return;
        }
        const generation = source.index.generation(slot);
        this.output.push(slot, generation, source.rank(slot));
        const exact = this.visitor?.(slot, generation);
        if (this.cancelled) return;
        if (exact !== undefined && this.request!.kind !== 'box') {
            if (!Number.isFinite(exact) || exact < 0) throw new RangeError('Nearest visitor must return a finite nonnegative exact distance');
            this.best = Math.min(this.best, exact);
        }
    }
    private compare(a: number, b: number): number {
        const ranks = this.output.ranks, slots = this.output.slots;
        const value = ranks[a] - ranks[b] || slots[a] - slots[b];
        return this.request!.order === 'reverse' ? -value : value;
    }
    private sift(root: number, end: number): void {
        while (2 * root + 1 < end) {
            let child = 2 * root + 1;
            if (child + 1 < end && this.compare(child, child + 1) < 0) child++;
            if (this.compare(root, child) >= 0) return;
            this.output.swap(root, child); root = child;
        }
    }
    step(maxWork: number): QueryStatus {
        if (this.state !== 'pending') return this.state;
        if (!Number.isSafeInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid spatial query slice');
        if (this.stepping) throw new Error('Spatial query step is not reentrant');
        this.stepping = true;
        try {
            for (let work = 0; work < maxWork; work++) {
                if (!this.current()) return this.finish('stale');
                if (this.unbounded) {
                    const next = this.unbounded.next();
                    if (next.done) this.unbounded = undefined;
                    else this.candidate(next.value, true);
                } else if (this.frontier.length) {
                    this.frontier.pop();
                    if (this.frontier.distance > this.best) continue;
                    const index = this.source!.index, node = this.frontier.node;
                    if (this.frontier.isDynamic) {
                        if (index.edits.slot[node] >= 0) { if (index.editLeafValid(node)) this.candidate(index.edits.slot[node], false); }
                        else { this.enqueue(index.edits.left[node], true); this.enqueue(index.edits.right[node], true); }
                    } else if (node < index.packed.count) {
                        if (index.packedLeafValid(node)) this.candidate(index.packed.slots[node], false);
                    } else {
                        const first = index.packed.starts[node - index.packed.count], count = index.packed.counts[node - index.packed.count];
                        for (let i = 0; i < count; i++) this.enqueue(first + i, false);
                    }
                } else if (this.request!.order) {
                    if (!this.sorting) { this.sorting = true; this.sortBuild = (this.output.length >>> 1) - 1; this.sortEnd = this.output.length; }
                    if (this.sortBuild >= 0) this.sift(this.sortBuild--, this.sortEnd);
                    else if (this.sortEnd > 1) { this.output.swap(0, --this.sortEnd); this.sift(0, this.sortEnd); }
                    else return this.finish('complete');
                } else return this.finish('complete');
                if (this.cancelled) return 'cancelled';
                if (!this.current()) return this.finish('stale');
            }
            return 'pending';
        } catch (error) { this.finish('cancelled'); throw error; }
        finally { this.stepping = false; }
    }
}
