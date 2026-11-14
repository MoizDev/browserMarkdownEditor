import { intersects, validBox, writeBox } from './bounds';

export const INDEX_FANOUT = 16;
const ACTIVE = 0x80000000;
const GENERATION = 0x7fffffff;
const NONE = -1;

// Kamel/Faloutsos, "On Packing R-trees", CIKM 1993: order rectangle centres by Hilbert
// position and bulk-pack bottom-up. Own bitwise quadrant construction, no library implementation.
function hilbert(x: number, y: number): number {
    let position = 0;
    for (let bit = 32768; bit; bit >>= 1) {
        const right = x & bit ? 1 : 0, top = y & bit ? 1 : 0;
        position += bit * bit * ((3 * right) ^ top);
        if (!top) {
            if (right) { x = 65535 - x; y = 65535 - y; }
            const swap = x; x = y; y = swap;
        }
    }
    return position >>> 0;
}
export interface PackedSnapshot {
    readonly slots: Uint32Array;
    readonly generations: Uint32Array;
    readonly versions: Uint32Array;
    readonly bounds: Float64Array;
    readonly revision: number;
}
export class PackedTree {
    readonly count: number;
    readonly root: number;
    readonly bounds: Float64Array;
    readonly slots: Uint32Array;
    readonly generations: Uint32Array;
    readonly versions: Uint32Array;
    readonly starts: Uint32Array;
    readonly counts: Uint8Array;
    constructor(snapshot: PackedSnapshot) {
        const n = snapshot.slots.length;
        if (snapshot.generations.length !== n || snapshot.versions.length !== n || snapshot.bounds.length !== 4 * n) throw new RangeError('Invalid packed scene snapshot');
        this.count = n;
        let internal = 0, level = n;
        while (level > 1) { level = Math.ceil(level / INDEX_FANOUT); internal += level; }
        this.bounds = new Float64Array(4 * (n + internal)); this.slots = new Uint32Array(n);
        this.generations = new Uint32Array(n); this.versions = new Uint32Array(n);
        this.starts = new Uint32Array(internal); this.counts = new Uint8Array(internal);
        if (!n) { this.root = NONE; return; }
        const keys = new Uint32Array(n), order = new Uint32Array(n);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            if (!validBox(snapshot.bounds, 4 * i)) throw new RangeError('Invalid packed scene bounds');
            const x = snapshot.bounds[4 * i] / 2 + snapshot.bounds[4 * i + 2] / 2;
            const y = snapshot.bounds[4 * i + 1] / 2 + snapshot.bounds[4 * i + 3] / 2;
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        for (let i = 0; i < n; i++) {
            const x = snapshot.bounds[4 * i] / 2 + snapshot.bounds[4 * i + 2] / 2;
            const y = snapshot.bounds[4 * i + 1] / 2 + snapshot.bounds[4 * i + 3] / 2;
            const qx = maxX === minX ? 0 : Math.max(0, Math.min(65535, Math.floor((x - minX) / (maxX - minX) * 65535)));
            const qy = maxY === minY ? 0 : Math.max(0, Math.min(65535, Math.floor((y - minY) / (maxY - minY) * 65535)));
            keys[i] = hilbert(qx, qy); order[i] = i;
        }
        order.sort((a, b) => keys[a] - keys[b] || snapshot.slots[a] - snapshot.slots[b]);
        for (let i = 0; i < n; i++) {
            const source = order[i];
            this.slots[i] = snapshot.slots[source]; this.generations[i] = snapshot.generations[source]; this.versions[i] = snapshot.versions[source];
            for (let k = 0; k < 4; k++) this.bounds[4 * i + k] = snapshot.bounds[4 * source + k];
        }
        let begin = 0, length = n, target = n;
        while (length > 1) {
            const parents = Math.ceil(length / INDEX_FANOUT), next = target;
            for (let i = 0; i < parents; i++, target++) {
                const first = begin + i * INDEX_FANOUT, count = Math.min(INDEX_FANOUT, length - i * INDEX_FANOUT);
                this.starts[target - n] = first; this.counts[target - n] = count;
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (let child = first; child < first + count; child++) {
                    x0 = Math.min(x0, this.bounds[4 * child]); y0 = Math.min(y0, this.bounds[4 * child + 1]);
                    x1 = Math.max(x1, this.bounds[4 * child + 2]); y1 = Math.max(y1, this.bounds[4 * child + 3]);
                }
                writeBox(this.bounds, 4 * target, x0, y0, x1, y1);
            }
            begin = next; length = parents;
        }
        this.root = begin;
    }
    get byteLength(): number {
        return this.bounds.byteLength + this.slots.byteLength + this.generations.byteLength + this.versions.byteLength + this.starts.byteLength + this.counts.byteLength;
    }
}

// Balanced binary AABB hierarchy. Perimeter enlargement chooses siblings; ordinary AVL height
// rotations prevent sorted edits from degenerating into a linear chain. Rotations preserve the
// descendant set, not a search-key order. Own construction from these standard invariants.
class EditTree {
    root = NONE;
    bounds = new Float64Array(4 * 16);
    left = new Int32Array(16);
    right = new Int32Array(16);
    parent = new Int32Array(16);
    slot = new Int32Array(16);
    height = new Uint8Array(16);
    leaves = 0;
    private next = 0;
    private free = NONE;
    private allocate(): number {
        if (this.free !== NONE) { const node = this.free; this.free = this.left[node]; return node; }
        if (this.next === this.slot.length) {
            const capacity = this.next * 2;
            const bounds = new Float64Array(4 * capacity); bounds.set(this.bounds); this.bounds = bounds;
            const left = new Int32Array(capacity); left.set(this.left); this.left = left;
            const right = new Int32Array(capacity); right.set(this.right); this.right = right;
            const parent = new Int32Array(capacity); parent.set(this.parent); this.parent = parent;
            const slot = new Int32Array(capacity); slot.set(this.slot); this.slot = slot;
            const height = new Uint8Array(capacity); height.set(this.height); this.height = height;
        }
        return this.next++;
    }
    private release(node: number): void { this.slot[node] = -2; this.left[node] = this.free; this.free = node; }
    private perimeter(node: number): number { const i = 4 * node; return 2 * (this.bounds[i + 2] - this.bounds[i] + this.bounds[i + 3] - this.bounds[i + 1]); }
    private enlargement(node: number, box: ArrayLike<number>): number {
        const i = 4 * node;
        return 2 * (Math.max(this.bounds[i + 2], box[2]) - Math.min(this.bounds[i], box[0])
            + Math.max(this.bounds[i + 3], box[3]) - Math.min(this.bounds[i + 1], box[1])) - this.perimeter(node);
    }
    insert(slot: number, box: ArrayLike<number>, zoom: number): number {
        const leaf = this.allocate(), i = 4 * leaf;
        const x = Math.max(2 / zoom, (box[2] - box[0]) * 0.05), y = Math.max(2 / zoom, (box[3] - box[1]) * 0.05);
        writeBox(this.bounds, i, box[0] - x, box[1] - y, box[2] + x, box[3] + y);
        this.left[leaf] = this.right[leaf] = this.parent[leaf] = NONE; this.slot[leaf] = slot; this.height[leaf] = 0; this.leaves++;
        if (this.root === NONE) { this.root = leaf; return leaf; }
        let sibling = this.root;
        while (this.slot[sibling] < 0) {
            const a = this.left[sibling], b = this.right[sibling];
            const ca = this.enlargement(a, box), cb = this.enlargement(b, box);
            sibling = ca < cb || (ca === cb && this.height[a] <= this.height[b]) ? a : b;
        }
        const p = this.allocate(), old = this.parent[sibling];
        this.slot[p] = NONE; this.left[p] = sibling; this.right[p] = leaf; this.parent[p] = old;
        this.parent[sibling] = this.parent[leaf] = p;
        if (old === NONE) this.root = p; else if (this.left[old] === sibling) this.left[old] = p; else this.right[old] = p;
        this.refit(p);
        return leaf;
    }
    contains(leaf: number, box: ArrayLike<number>): boolean {
        const i = 4 * leaf;
        return this.bounds[i] <= box[0] && this.bounds[i + 1] <= box[1] && this.bounds[i + 2] >= box[2] && this.bounds[i + 3] >= box[3];
    }
    remove(leaf: number): void {
        const p = this.parent[leaf]; this.leaves--;
        if (p === NONE) { this.root = NONE; this.release(leaf); return; }
        const sibling = this.left[p] === leaf ? this.right[p] : this.left[p], grand = this.parent[p];
        if (grand === NONE) this.root = sibling;
        else if (this.left[grand] === p) this.left[grand] = sibling; else this.right[grand] = sibling;
        this.parent[sibling] = grand; this.release(leaf); this.release(p);
        this.refit(grand);
    }
    private update(n: number): void {
        if (this.slot[n] >= 0) return;
        const a = this.left[n], b = this.right[n], i = 4 * n, ai = 4 * a, bi = 4 * b;
        this.bounds[i] = Math.min(this.bounds[ai], this.bounds[bi]); this.bounds[i + 1] = Math.min(this.bounds[ai + 1], this.bounds[bi + 1]);
        this.bounds[i + 2] = Math.max(this.bounds[ai + 2], this.bounds[bi + 2]); this.bounds[i + 3] = Math.max(this.bounds[ai + 3], this.bounds[bi + 3]);
        this.height[n] = 1 + Math.max(this.height[a], this.height[b]);
    }
    private rotate(n: number, left: boolean): number {
        const top = left ? this.right[n] : this.left[n], middle = left ? this.left[top] : this.right[top], parent = this.parent[n];
        if (parent === NONE) this.root = top; else if (this.left[parent] === n) this.left[parent] = top; else this.right[parent] = top;
        this.parent[top] = parent; this.parent[n] = top; this.parent[middle] = n;
        if (left) { this.right[n] = middle; this.left[top] = n; } else { this.left[n] = middle; this.right[top] = n; }
        this.update(n); this.update(top);
        return top;
    }
    private refit(start: number): void {
        let node = start;
        while (node !== NONE) {
            this.update(node);
            const a = this.left[node], b = this.right[node];
            if (a !== NONE && b !== NONE) {
                if (this.height[a] > this.height[b] + 1) {
                    if (this.height[this.right[a]] > this.height[this.left[a]]) this.rotate(a, true);
                    node = this.rotate(node, false);
                } else if (this.height[b] > this.height[a] + 1) {
                    if (this.height[this.left[b]] > this.height[this.right[b]]) this.rotate(b, false);
                    node = this.rotate(node, true);
                }
            }
            node = this.parent[node];
        }
    }
    get byteLength(): number { return this.bounds.byteLength + this.left.byteLength + this.right.byteLength + this.parent.byteLength + this.slot.byteLength + this.height.byteLength; }
}

const EMPTY_SNAPSHOT: PackedSnapshot = { slots: new Uint32Array(0), generations: new Uint32Array(0), versions: new Uint32Array(0), bounds: new Float64Array(0), revision: 0 };
export class HybridIndex {
    packed = new PackedTree(EMPTY_SNAPSHOT);
    readonly edits = new EditTree();
    private generations = new Uint32Array(16);
    private versions = new Uint32Array(16);
    private dynamic = new Int32Array(16).fill(-2);
    private next = 0;
    private free = NONE;
    private active = 0;
    private cleanup = 0;
    private queryLeases = 0;
    epoch = 0;
    get capacity(): number { return this.generations.length; }
    get count(): number { return this.active; }
    get highWater(): number { return this.next; }
    get byteLength(): number { return this.packed.byteLength + this.edits.byteLength + this.generations.byteLength + this.versions.byteLength + this.dynamic.byteLength; }
    get needsRebuild(): boolean { return this.cleanup >= this.packed.count && this.edits.leaves > Math.max(2048, this.active * 0.05); }
    get needsCleanup(): boolean { return this.queryLeases === 0 && this.edits.leaves > 0 && this.cleanup < this.packed.count; }
    reserve(count: number): void {
        if (count <= this.capacity) return;
        let capacity = this.capacity;
        while (capacity < count) capacity *= 2;
        const generations = new Uint32Array(capacity); generations.set(this.generations); this.generations = generations;
        const versions = new Uint32Array(capacity); versions.set(this.versions); this.versions = versions;
        const dynamic = new Int32Array(capacity).fill(-2); dynamic.set(this.dynamic); this.dynamic = dynamic;
    }
    allocate(): number {
        let slot: number;
        if (this.free !== NONE) { slot = this.free; this.free = this.dynamic[slot]; }
        else { this.reserve(this.next + 1); slot = this.next++; }
        const generation = (this.generations[slot] & GENERATION) + 1;
        if (generation > GENERATION) throw new RangeError('Scene slot generation exhausted; create a new scene session');
        this.generations[slot] = (generation | ACTIVE) >>> 0; this.versions[slot] = 1; this.dynamic[slot] = -2;
        this.active++; this.epoch++;
        return slot;
    }
    alive(slot: number): boolean { return slot >= 0 && slot < this.next && !!(this.generations[slot] & ACTIVE); }
    generation(slot: number): number { return this.generations[slot] & GENERATION; }
    version(slot: number): number { return this.versions[slot]; }
    hasBounds(slot: number): boolean { return this.alive(slot) && this.dynamic[slot] !== -2; }
    release(slot: number): void {
        if (!this.alive(slot)) return;
        this.removeBounds(slot); this.generations[slot] &= GENERATION;
        this.dynamic[slot] = this.free; this.free = slot; this.active--; this.epoch++;
    }
    upsert(slot: number, box: ArrayLike<number>, zoom: number): void {
        if (!this.alive(slot) || !validBox(box) || !Number.isFinite(zoom) || zoom <= 0) throw new RangeError('Invalid live spatial entry');
        if (this.versions[slot] === 0xffffffff) throw new RangeError('Scene spatial version exhausted; rebuild the scene session');
        this.versions[slot]++; this.epoch++;
        const leaf = this.dynamic[slot];
        if (leaf >= 0 && this.edits.contains(leaf, box)) return;
        if (leaf >= 0) this.edits.remove(leaf);
        this.dynamic[slot] = this.edits.insert(slot, box, zoom);
    }
    removeBounds(slot: number): void {
        if (!this.alive(slot)) return;
        const leaf = this.dynamic[slot];
        if (leaf >= 0) this.edits.remove(leaf);
        this.dynamic[slot] = -2; this.versions[slot]++; this.epoch++;
    }
    packedLeafValid(leaf: number): boolean {
        const p = this.packed, slot = p.slots[leaf];
        return this.alive(slot) && this.dynamic[slot] === NONE && this.generation(slot) === p.generations[leaf] && this.version(slot) === p.versions[leaf];
    }
    editLeafValid(leaf: number): boolean {
        const slot = this.edits.slot[leaf];
        return slot >= 0 && this.alive(slot) && this.dynamic[slot] === leaf;
    }
    acquireQuery(): void { this.queryLeases++; }
    releaseQuery(): void { this.queryLeases--; }
    publish(packed: PackedTree): boolean {
        // A source snapshot may be old: versions mask removed/changed entries and every newer
        // edit stays in the overlay. No replay is lost. Topology swaps wait for active cursors.
        if (this.queryLeases) return false;
        this.packed = packed; this.cleanup = 0; this.epoch++;
        if (!this.edits.leaves) this.cleanup = packed.count;
        return true;
    }
    cleanupStep(maxVisits: number): boolean {
        if (this.queryLeases) return false;
        for (let i = 0; i < maxVisits && this.cleanup < this.packed.count && this.edits.leaves; i++) {
            const leaf = this.cleanup++, slot = this.packed.slots[leaf], dynamic = this.dynamic[slot];
            if (dynamic >= 0 && this.alive(slot) && this.generation(slot) === this.packed.generations[leaf] && this.version(slot) === this.packed.versions[leaf]) {
                this.edits.remove(dynamic); this.dynamic[slot] = NONE;
            }
        }
        if (!this.edits.leaves) this.cleanup = this.packed.count;
        return this.cleanup >= this.packed.count;
    }
    overlapsPacked(node: number, box: ArrayLike<number>): boolean { return intersects(this.packed.bounds, 4 * node, box, 0); }
}
