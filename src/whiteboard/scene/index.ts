import { intersects, validBox, writeBox } from './bounds';
import { PackedBuildJob } from './packedBuild';
import type { PackedSnapshot, PackedTreeData } from './packedBuild';
export { INDEX_FANOUT, PackedBuildJob } from './packedBuild';
export type { PackedSnapshot, PackedTreeData } from './packedBuild';
const ACTIVE = 0x80000000;
const GENERATION = 0x7fffffff;
const NONE = -1;

export class PackedTree {
    readonly revision!: number;
    readonly membership!: Uint32Array;
    readonly count!: number;
    readonly root!: number;
    readonly bounds!: Float64Array;
    readonly slots!: Uint32Array;
    readonly generations!: Uint32Array;
    readonly versions!: Uint32Array;
    readonly starts!: Uint32Array;
    readonly counts!: Uint8Array;
    constructor(snapshot: PackedSnapshot) {
        const job = new PackedBuildJob(snapshot);
        while (job.step(4096) === 'pending') { /* Synchronous bounded-data convenience only. */ }
        Object.assign(this, job.result);
    }
    /** Worker results transfer these arrays; adoption is O(1), never another N-item build. */
    static fromData(data: PackedTreeData): PackedTree {
        const n = data.count, total = data.bounds.length / 4;
        if (!Number.isSafeInteger(n) || n < 0 || data.slots.length !== n || data.generations.length !== n || data.versions.length !== n
            || total < n || !Number.isInteger(total) || data.starts.length !== total - n || data.counts.length !== total - n
            || data.root !== (n ? total - 1 : -1) || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new RangeError('Invalid packed tree transport');
        return Object.assign(Object.create(PackedTree.prototype) as PackedTree, data);
    }
    hasSlot(slot: number): boolean { return !!(this.membership[slot >>> 5] & (1 << (slot & 31))); }
    get byteLength(): number {
        return this.bounds.byteLength + this.slots.byteLength + this.generations.byteLength + this.versions.byteLength + this.starts.byteLength + this.counts.byteLength + this.membership.byteLength;
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
    trimEmpty(): void {
        if (this.leaves || this.slot.length === 16) return;
        this.bounds = new Float64Array(64); this.left = new Int32Array(16); this.right = new Int32Array(16);
        this.parent = new Int32Array(16); this.slot = new Int32Array(16); this.height = new Uint8Array(16);
        this.next = 0; this.free = NONE; this.root = NONE;
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
    private cleanupWord = 0;
    private seeded = 0;
    private dirty = new Uint32Array(1);
    private dirtyCount = 0;
    private queryLeases = 0;
    epoch = 0;
    get capacity(): number { return this.generations.length; }
    get count(): number { return this.active; }
    get highWater(): number { return this.next; }
    get ready(): boolean { return this.seeded === 0; }
    get byteLength(): number { return this.packed.byteLength + this.edits.byteLength + this.generations.byteLength + this.versions.byteLength + this.dynamic.byteLength + this.dirty.byteLength; }
    get needsRebuild(): boolean { return this.cleanup >= this.packed.count && this.cleanupWord >= this.dirty.length && this.dirtyCount > Math.max(2048, this.active * 0.05); }
    get needsCleanup(): boolean { return this.queryLeases === 0 && (this.cleanup < this.packed.count || this.cleanupWord < this.dirty.length); }
    private markDirty(slot: number): void {
        const word = slot >>> 5, bit = 1 << (slot & 31);
        if (!(this.dirty[word] & bit)) { this.dirty[word] |= bit; this.dirtyCount++; }
    }
    private clearDirty(slot: number): void {
        const word = slot >>> 5, bit = 1 << (slot & 31);
        if (this.dirty[word] & bit) { this.dirty[word] &= ~bit; this.dirtyCount--; }
    }
    // Only cold construction uses this: no binary tree ever reserves 2N nodes just to discard
    // them after packing. Queries and edits wait until the matching seed snapshot is published.
    seedBounds(slot: number): void {
        if (!this.alive(slot) || this.dynamic[slot] !== -2 || this.packed.count || this.edits.leaves || this.queryLeases) throw new Error('Invalid cold index seed');
        this.dynamic[slot] = NONE; this.seeded++; this.epoch++;
    }
    reserve(count: number): void {
        if (count <= this.capacity) return;
        let capacity = this.capacity;
        while (capacity < count) capacity *= 2;
        const generations = new Uint32Array(capacity); generations.set(this.generations); this.generations = generations;
        const versions = new Uint32Array(capacity); versions.set(this.versions); this.versions = versions;
        const dynamic = new Int32Array(capacity).fill(-2); dynamic.set(this.dynamic); this.dynamic = dynamic;
        const dirty = new Uint32Array(Math.ceil(capacity / 32)); dirty.set(this.dirty); this.dirty = dirty;
        if (!this.dirtyCount) this.cleanupWord = dirty.length;
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
        if (this.seeded) throw new Error('Publish the cold seed snapshot before editing');
        if (!this.alive(slot) || !validBox(box) || !Number.isFinite(zoom) || zoom <= 0) throw new RangeError('Invalid live spatial entry');
        if (this.versions[slot] === 0xffffffff) throw new RangeError('Scene spatial version exhausted; rebuild the scene session');
        this.versions[slot]++; this.epoch++; this.markDirty(slot);
        const leaf = this.dynamic[slot];
        if (leaf >= 0 && this.edits.contains(leaf, box)) return;
        if (leaf >= 0) this.edits.remove(leaf);
        this.dynamic[slot] = this.edits.insert(slot, box, zoom);
    }
    removeBounds(slot: number): void {
        if (this.seeded) throw new Error('Publish the cold seed snapshot before editing');
        if (!this.alive(slot) || this.dynamic[slot] === -2) return;
        if (this.versions[slot] === 0xffffffff) throw new RangeError('Scene spatial version exhausted');
        const leaf = this.dynamic[slot];
        if (leaf >= 0) this.edits.remove(leaf);
        this.markDirty(slot); this.dynamic[slot] = -2; this.versions[slot]++; this.epoch++;
    }
    packedLeafValid(leaf: number): boolean {
        const p = this.packed, slot = p.slots[leaf];
        return this.alive(slot) && this.dynamic[slot] === NONE && this.generation(slot) === p.generations[leaf] && this.version(slot) === p.versions[leaf];
    }
    editLeafValid(leaf: number): boolean {
        const slot = this.edits.slot[leaf];
        return slot >= 0 && this.alive(slot) && this.dynamic[slot] === leaf;
    }
    acquireQuery(): void { if (!this.ready) throw new Error('Cold spatial index is not published'); this.queryLeases++; }
    releaseQuery(): void { if (this.queryLeases <= 0) throw new Error('Unbalanced spatial query lease'); this.queryLeases--; }
    publish(packed: PackedTree): boolean {
        // A source snapshot may be old: versions mask removed/changed entries and every newer
        // edit stays in the overlay. No replay is lost. Topology swaps wait for active cursors.
        if (this.queryLeases || packed.revision < this.packed.revision || packed.revision > this.epoch) return false;
        if (this.seeded && (packed.revision !== this.epoch || packed.count !== this.seeded)) return false;
        this.packed = packed; this.seeded = 0; this.cleanup = this.dirtyCount ? 0 : packed.count;
        this.cleanupWord = this.dirtyCount ? 0 : this.dirty.length; this.epoch++;
        return true;
    }
    cleanupStep(maxVisits: number): boolean {
        if (!Number.isSafeInteger(maxVisits) || maxVisits <= 0) throw new RangeError('Invalid spatial cleanup slice');
        if (this.queryLeases) return false;
        for (let i = 0; i < maxVisits; i++) {
            if (this.cleanup < this.packed.count) {
                const leaf = this.cleanup++, slot = this.packed.slots[leaf], dynamic = this.dynamic[slot];
                if (this.alive(slot) && this.generation(slot) === this.packed.generations[leaf] && this.version(slot) === this.packed.versions[leaf]) {
                    if (dynamic >= 0) this.edits.remove(dynamic);
                    if (dynamic !== -2) this.dynamic[slot] = NONE;
                    this.clearDirty(slot);
                }
            } else if (this.cleanupWord < this.dirty.length) {
                const word = this.cleanupWord++, bits = this.dirty[word];
                if (bits) for (let bit = 0; bit < 32; bit++) {
                    const slot = word * 32 + bit;
                    if ((bits & (1 << bit)) && (!this.alive(slot) || this.dynamic[slot] < 0) && !this.packed.hasSlot(slot)) this.clearDirty(slot);
                }
            } else break;
        }
        this.edits.trimEmpty();
        return !this.needsCleanup;
    }
    overlapsPacked(node: number, box: ArrayLike<number>): boolean { return intersects(this.packed.bounds, 4 * node, box, 0); }
}
