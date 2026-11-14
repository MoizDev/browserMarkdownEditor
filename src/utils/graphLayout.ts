// Doubles and the original a<b update order are intentional: small vaults keep
// today's trajectories, not just a visually similar force law.
export const GRAPH_EXACT_LIMIT = 600;
// Unqualified design reading: all5000 nodes over steps1–10, nine geometries.
// |F_bh-F_exact| / sum_j|f_ij| avoids ill-conditioned cancelling net forces:
// theta0.7 p95=1.47–1.75%;0.9=2.54–3.26%. Core selected0.7, retaining600 exact.
// Node26 CPU was ~8ms/5000 at0.7, not a Chromium-worker time claim.
export const GRAPH_THETA = 0.7;
const REPULSION = 16000;
const MIN_D2 = 100;
const MAX_DEPTH = 32;

export interface LayoutPoints {
    x: Float64Array;
    y: Float64Array;
    vx: Float64Array;
    vy: Float64Array;
}

export function exactRepulsion({ x, y, vx, vy }: LayoutPoints, alpha: number): void {
    for (let a = 0; a < x.length; a++) {
        for (let b = a + 1; b < x.length; b++) {
            let dx = x[a] - x[b];
            let dy = y[a] - y[b];
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) { dx = (a - b) || 1; dy = 1; d2 = dx * dx + dy * dy; }
            const dist = Math.sqrt(d2);
            const force = (REPULSION / Math.max(d2, MIN_D2)) * alpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            vx[a] += fx; vy[a] += fy;
            vx[b] -= fx; vy[b] -= fy;
        }
    }
}

function growFloats(old: Float64Array, size: number) {
    const next = new Float64Array(size); next.set(old); return next;
}
function growInts(old: Int32Array, size: number) {
    const next = new Int32Array(size); next.set(old); return next;
}

/** Rebuilt in retained storage; depth-limited buckets also handle all-coincident
 *  inputs without infinite subdivision. Child order and bucket order are fixed. */
export class RepulsionTree {
    private capacity = 0;
    private used = 0;
    private left = new Float64Array(0);
    private top = new Float64Array(0);
    private width = new Float64Array(0);
    private massX = new Float64Array(0);
    private massY = new Float64Array(0);
    private count = new Int32Array(0);
    private children = new Int32Array(0);
    private head = new Int32Array(0);
    private nextPoint = new Int32Array(0);
    // A depth-first quadtree walk has at most 1+3*depth pending siblings.
    private stack = new Int32Array(1 + 3 * MAX_DEPTH);

    private cell(left: number, top: number, width: number): number {
        if (this.used === this.capacity) {
            this.capacity = Math.max(256, this.capacity * 2);
            this.left = growFloats(this.left, this.capacity);
            this.top = growFloats(this.top, this.capacity);
            this.width = growFloats(this.width, this.capacity);
            this.massX = growFloats(this.massX, this.capacity);
            this.massY = growFloats(this.massY, this.capacity);
            this.count = growInts(this.count, this.capacity);
            this.head = growInts(this.head, this.capacity);
            this.children = growInts(this.children, this.capacity * 4);
        }
        const c = this.used++;
        this.left[c] = left; this.top[c] = top; this.width[c] = width;
        this.massX[c] = 0; this.massY[c] = 0; this.count[c] = 0;
        this.head[c] = -1;
        this.children.fill(-1, c * 4, c * 4 + 4);
        return c;
    }

    rebuild(x: Float64Array, y: Float64Array): void {
        this.used = 0;
        if (!x.length) return;
        if (this.nextPoint.length < x.length) this.nextPoint = new Int32Array(x.length);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < x.length; i++) {
            minX = Math.min(minX, x[i]); minY = Math.min(minY, y[i]);
            maxX = Math.max(maxX, x[i]); maxY = Math.max(maxY, y[i]);
        }
        this.cell(minX, minY, Math.max(1, maxX - minX, maxY - minY));
        for (let i = 0; i < x.length; i++) {
            let c = 0, depth = 0;
            this.nextPoint[i] = -1;
            while (true) {
                this.count[c]++;
                this.massX[c] += x[i]; this.massY[c] += y[i];
                if (this.children[c * 4] === -1) {
                    const old = this.head[c];
                    if (old === -1 || depth === MAX_DEPTH) {
                        this.nextPoint[i] = old;
                        this.head[c] = i;
                        break;
                    }
                    const half = this.width[c] / 2;
                    const left = this.left[c], top = this.top[c];
                    // cell() may grow every buffer, so don't retain a pre-growth
                    // children reference across the split.
                    for (let q = 0; q < 4; q++) {
                        const child = this.cell(left + (q & 1) * half, top + (q >> 1) * half, half);
                        this.children[c * 4 + q] = child;
                    }
                    const q = (x[old] >= left + half ? 1 : 0) + (y[old] >= top + half ? 2 : 0);
                    const child = this.children[c * 4 + q];
                    this.head[child] = old;
                    this.count[child] = 1;
                    this.massX[child] = x[old]; this.massY[child] = y[old];
                    this.head[c] = -1;
                }
                const half = this.width[c] / 2;
                const q = (x[i] >= this.left[c] + half ? 1 : 0) + (y[i] >= this.top[c] + half ? 2 : 0);
                c = this.children[c * 4 + q];
                depth++;
            }
        }
        for (let c = 0; c < this.used; c++) if (this.count[c]) {
            this.massX[c] /= this.count[c]; this.massY[c] /= this.count[c];
        }
    }

    addForces({ x, y, vx, vy }: LayoutPoints, alpha: number, theta: number): void {
        const theta2 = theta * theta;
        for (let i = 0; i < x.length; i++) {
            let pending = 1;
            this.stack[0] = 0;
            while (pending) {
                const c = this.stack[--pending];
                if (!this.count[c]) continue;
                if (this.children[c * 4] === -1) {
                    for (let j = this.head[c]; j !== -1; j = this.nextPoint[j]) {
                        if (i === j) continue;
                        let dx = x[i] - x[j], dy = y[i] - y[j];
                        let d2 = dx * dx + dy * dy;
                        // The array-index fallback sets the magnitude too. For
                        // indices20 apart it is 16000/401, not 16000/100.
                        if (d2 < 0.01) { dx = i - j; dy = i < j ? 1 : -1; d2 = dx * dx + 1; }
                        const dist = Math.sqrt(d2);
                        const force = (REPULSION / Math.max(d2, MIN_D2)) * alpha;
                        vx[i] += (dx / dist) * force; vy[i] += (dy / dist) * force;
                    }
                    continue;
                }
                const dx = x[i] - this.massX[c], dy = y[i] - this.massY[c];
                const d2 = dx * dx + dy * dy;
                const w = this.width[c];
                const bx = Math.max(this.left[c] - x[i], 0, x[i] - (this.left[c] + w));
                const by = Math.max(this.top[c] - y[i], 0, y[i] - (this.top[c] + w));
                // A containing cell always opens. So does a cell touching the
                // near-coincidence zone: its COM must not hide pair fallbacks.
                if (bx * bx + by * by >= 0.01 && w * w < theta2 * d2) {
                    const dist = Math.sqrt(d2);
                    const force = (REPULSION * this.count[c] / Math.max(d2, MIN_D2)) * alpha;
                    vx[i] += (dx / dist) * force; vy[i] += (dy / dist) * force;
                } else {
                    for (let q = 3; q >= 0; q--) this.stack[pending++] = this.children[c * 4 + q];
                }
            }
        }
    }
}

/** Plain data/math shared by the main-thread host and the layout worker. */
export class GraphLayout implements LayoutPoints {
    ids: readonly string[] = [];
    index = new Map<string, number>();
    x = new Float64Array(0);
    y = new Float64Array(0);
    vx = new Float64Array(0);
    vy = new Float64Array(0);
    source = new Int32Array(0);
    target = new Int32Array(0);
    alpha = 1;
    private tree = new RepulsionTree();

    update(ids: readonly string[], links: readonly { source: string; target: string }[]): void {
        const previous = this.index;
        const x = new Float64Array(ids.length), y = new Float64Array(ids.length);
        const vx = new Float64Array(ids.length), vy = new Float64Array(ids.length);
        let seed = 0;
        for (const id of ids) if (previous.has(id)) seed++;
        const index = new Map<string, number>();
        for (let i = 0; i < ids.length; i++) {
            const old = previous.get(ids[i]);
            index.set(ids[i], i);
            if (old !== undefined) {
                x[i] = this.x[old]; y[i] = this.y[old];
                vx[i] = this.vx[old]; vy[i] = this.vy[old];
            } else {
                const angle = seed * 2.399963;
                const radius = 30 + 12 * Math.sqrt(seed++);
                x[i] = Math.cos(angle) * radius; y[i] = Math.sin(angle) * radius;
            }
        }
        this.ids = ids.slice(); this.index = index;
        this.x = x; this.y = y; this.vx = vx; this.vy = vy;
        const source = new Int32Array(links.length), target = new Int32Array(links.length);
        let count = 0;
        for (const link of links) {
            const s = index.get(link.source), t = index.get(link.target);
            if (s === undefined || t === undefined) continue;
            source[count] = s; target[count++] = t;
        }
        this.source = source.subarray(0, count); this.target = target.subarray(0, count);
        this.alpha = 1;
    }

    step(draggedId: string | null = null): boolean {
        let alpha = this.alpha;
        if (alpha < 0.001 && draggedId === null) return false;
        if (draggedId !== null) alpha = Math.max(alpha, 0.1);
        if (this.ids.length <= GRAPH_EXACT_LIMIT) exactRepulsion(this, alpha);
        else {
            this.tree.rebuild(this.x, this.y);
            this.tree.addForces(this, alpha, GRAPH_THETA);
        }
        return this.integrate(alpha, draggedId);
    }

    private integrate(alpha: number, draggedId: string | null): boolean {
        const { x, y, vx, vy, source, target } = this;
        for (let e = 0; e < source.length; e++) {
            const s = source[e], t = target[e];
            const dx = x[t] - x[s], dy = y[t] - y[s];
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const force = (dist - 150) * 0.03 * alpha;
            const fx = (dx / dist) * force, fy = (dy / dist) * force;
            vx[s] += fx; vy[s] += fy;
            vx[t] -= fx; vy[t] -= fy;
        }
        const center = 0.004 + 0.0006 * Math.sqrt(this.ids.length);
        const pinned = draggedId === null ? -1 : (this.index.get(draggedId) ?? -1);
        for (let i = 0; i < x.length; i++) {
            if (i === pinned) { vx[i] = 0; vy[i] = 0; continue; }
            vx[i] += -x[i] * center * alpha;
            vy[i] += -y[i] * center * alpha;
            vx[i] *= 0.6; vy[i] *= 0.6;
            vx[i] = Math.max(-8, Math.min(8, vx[i]));
            vy[i] = Math.max(-8, Math.min(8, vy[i]));
            x[i] += vx[i]; y[i] += vy[i];
        }
        if (draggedId === null) this.alpha = alpha + (0 - alpha) * 0.0228;
        return true;
    }
}
