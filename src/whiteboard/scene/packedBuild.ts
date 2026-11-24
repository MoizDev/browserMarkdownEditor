import { validBox, writeBox } from '../geom/bounds';

export const INDEX_FANOUT = 16;
export interface PackedSnapshot {
    readonly slots: Uint32Array;
    readonly generations: Uint32Array;
    readonly versions: Uint32Array;
    readonly bounds: Float64Array;
    readonly revision: number; // Captured HybridIndex.epoch, not document rev.
}
export interface PackedTreeData extends PackedSnapshot {
    readonly count: number;
    readonly root: number;
    readonly membership: Uint32Array;
    readonly starts: Uint32Array;
    readonly counts: Uint8Array;
}
function hilbert(x: number, y: number): number {
    let result = 0;
    for (let bit = 32768; bit; bit >>= 1) {
        const right = x & bit ? 1 : 0, top = y & bit ? 1 : 0;
        result += bit * bit * ((3 * right) ^ top);
        if (!top) {
            if (right) { x = 65535 - x; y = 65535 - y; }
            const swap = x; x = y; y = swap;
        }
    }
    return result >>> 0;
}

// Same bulk packing as index.ts, but every scan, heap sift and fanout16 union yields a work
// boundary. No native whole-array sort hides inside a worker's otherwise cooperative slice.
export class PackedBuildJob {
    private input: PackedSnapshot | undefined;
    private readonly n: number;
    private keys: Uint32Array;
    private order: Uint32Array;
    private data: PackedTreeData | undefined;
    private resultValue: PackedTreeData | undefined;
    private phase: 'extent' | 'keys' | 'heap' | 'sort' | 'copy' | 'parents' | 'complete' | 'cancelled' | 'failed' = 'extent';
    private failure: unknown;
    private cursor = 0;
    private minX = Infinity; private minY = Infinity; private maxX = -Infinity; private maxY = -Infinity;
    private highest = -1;
    private heapBuild = -1;
    private heapEnd = 0;
    private levelBegin = 0;
    private levelLength = 0;
    private levelParent = 0;
    private levelTarget = 0;
    private levelParents = 0;
    private target = 0;
    constructor(input: PackedSnapshot) {
        const n = input.slots.length;
        if (input.generations.length !== n || input.versions.length !== n || input.bounds.length !== 4 * n
            || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new RangeError('Invalid packed scene snapshot');
        this.input = input; this.n = n; this.keys = new Uint32Array(n); this.order = new Uint32Array(n);
        let internal = 0, level = n;
        while (level > 1) { level = Math.ceil(level / INDEX_FANOUT); internal += level; }
        this.data = { revision: input.revision, count: n, root: n ? n + internal - 1 : -1,
            bounds: new Float64Array(4 * (n + internal)), slots: new Uint32Array(n), generations: new Uint32Array(n), versions: new Uint32Array(n),
            membership: new Uint32Array(0), starts: new Uint32Array(internal), counts: new Uint8Array(internal) };
    }
    get result(): PackedTreeData { if (!this.resultValue) throw new Error('Packed scene build is not complete'); return this.resultValue; }
    get byteLength(): number {
        const data = this.data ?? this.resultValue;
        return this.keys.byteLength + this.order.byteLength + (data ? data.bounds.byteLength + data.slots.byteLength
            + data.generations.byteLength + data.versions.byteLength + data.membership.byteLength + data.starts.byteLength + data.counts.byteLength : 0);
    }
    cancel(): void {
        if (this.phase === 'complete' || this.phase === 'cancelled' || this.phase === 'failed') return;
        this.phase = 'cancelled'; this.drop();
    }
    private drop(): void { this.input = undefined; this.data = undefined; this.keys = new Uint32Array(0); this.order = new Uint32Array(0); }
    private compare(a: number, b: number): number { return this.keys[a] - this.keys[b] || this.input!.slots[a] - this.input!.slots[b]; }
    private sift(root: number, end: number): void {
        while (root * 2 + 1 < end) {
            let child = root * 2 + 1;
            if (child + 1 < end && this.compare(this.order[child], this.order[child + 1]) < 0) child++;
            if (this.compare(this.order[root], this.order[child]) >= 0) return;
            const swap = this.order[root]; this.order[root] = this.order[child]; this.order[child] = swap; root = child;
        }
    }
    step(maxWork: number): 'pending' | 'complete' | 'cancelled' {
        if (this.phase === 'failed') throw this.failure;
        if (this.phase === 'complete' || this.phase === 'cancelled') return this.phase;
        if (!Number.isSafeInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid packed-build slice');
        try {
            for (let work = 0; work < maxWork; work++) {
                const source = this.input!, data = this.data!;
                switch (this.phase) {
                    case 'extent': {
                        if (this.cursor === this.n) {
                            this.data = { ...data, membership: new Uint32Array(Math.ceil((this.highest + 1) / 32)) };
                            this.cursor = 0; this.phase = 'keys'; break;
                        }
                        const i = this.cursor++;
                        if (!validBox(source.bounds, 4 * i)) throw new RangeError('Invalid packed scene bounds');
                        const x = source.bounds[4 * i] / 2 + source.bounds[4 * i + 2] / 2;
                        const y = source.bounds[4 * i + 1] / 2 + source.bounds[4 * i + 3] / 2;
                        this.minX = Math.min(this.minX, x); this.minY = Math.min(this.minY, y);
                        this.maxX = Math.max(this.maxX, x); this.maxY = Math.max(this.maxY, y); this.highest = Math.max(this.highest, source.slots[i]);
                        break;
                    }
                    case 'keys': {
                        if (this.cursor === this.n) { this.heapBuild = (this.n >>> 1) - 1; this.heapEnd = this.n; this.phase = 'heap'; break; }
                        const i = this.cursor++, x = source.bounds[4 * i] / 2 + source.bounds[4 * i + 2] / 2;
                        const y = source.bounds[4 * i + 1] / 2 + source.bounds[4 * i + 3] / 2;
                        const qx = this.maxX === this.minX ? 0 : Math.max(0, Math.min(65535, Math.floor((x - this.minX) / (this.maxX - this.minX) * 65535)));
                        const qy = this.maxY === this.minY ? 0 : Math.max(0, Math.min(65535, Math.floor((y - this.minY) / (this.maxY - this.minY) * 65535)));
                        this.keys[i] = hilbert(qx, qy); this.order[i] = i; break;
                    }
                    case 'heap':
                        if (this.heapBuild >= 0) this.sift(this.heapBuild--, this.heapEnd);
                        else this.phase = 'sort';
                        break;
                    case 'sort':
                        if (this.heapEnd > 1) {
                            const swap = this.order[0]; this.order[0] = this.order[--this.heapEnd]; this.order[this.heapEnd] = swap; this.sift(0, this.heapEnd);
                        } else { this.cursor = 0; this.phase = 'copy'; }
                        break;
                    case 'copy': {
                        if (this.cursor === this.n) {
                            this.levelBegin = 0; this.levelLength = this.n; this.target = this.n;
                            this.levelTarget = this.target; this.levelParent = 0; this.levelParents = Math.ceil(this.n / INDEX_FANOUT); this.phase = 'parents'; break;
                        }
                        const i = this.cursor++, row = this.order[i], slot = source.slots[row];
                        data.slots[i] = slot; data.generations[i] = source.generations[row]; data.versions[i] = source.versions[row];
                        data.membership[slot >>> 5] |= 1 << (slot & 31);
                        for (let k = 0; k < 4; k++) data.bounds[4 * i + k] = source.bounds[4 * row + k];
                        break;
                    }
                    case 'parents': {
                        if (this.levelLength <= 1) {
                            this.resultValue = Object.freeze(data); this.phase = 'complete'; this.drop(); return 'complete';
                        }
                        if (this.levelParent === this.levelParents) {
                            this.levelBegin = this.levelTarget; this.levelLength = this.levelParents;
                            this.levelTarget = this.target; this.levelParent = 0; this.levelParents = Math.ceil(this.levelLength / INDEX_FANOUT); break;
                        }
                        const first = this.levelBegin + this.levelParent * INDEX_FANOUT;
                        const count = Math.min(INDEX_FANOUT, this.levelLength - this.levelParent++ * INDEX_FANOUT), parent = this.target++;
                        data.starts[parent - this.n] = first; data.counts[parent - this.n] = count;
                        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                        for (let child = first; child < first + count; child++) {
                            x0 = Math.min(x0, data.bounds[4 * child]); y0 = Math.min(y0, data.bounds[4 * child + 1]);
                            x1 = Math.max(x1, data.bounds[4 * child + 2]); y1 = Math.max(y1, data.bounds[4 * child + 3]);
                        }
                        writeBox(data.bounds, 4 * parent, x0, y0, x1, y1); break;
                    }
                }
            }
            return 'pending';
        } catch (error) { this.failure = error; this.phase = 'failed'; this.drop(); throw error; }
    }
}
