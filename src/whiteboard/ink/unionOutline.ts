export interface UnionOutline {
    readonly edges: Float64Array | null;
    readonly why: 'closed' | 'runs' | 'taper' | 'winding' | null;
}

function arcStep(r: number, tolerance: number): number {
    if (!(r > tolerance)) return Math.PI / 4;
    return Math.min(Math.PI / 4, Math.max(2 * Math.PI / 4096, 2 * Math.acos(1 - tolerance / r)));
}
const SAME_POINT = 1e-7;
const MIN_MITER = 0.05;
const ORIENT_EPS = 1e-12;

export function unionOutline(segments: Float64Array, discs: Float64Array, runStarts: ArrayLike<number>, closed: boolean, tolerance: number): UnionOutline {
    if (closed && segments.length) return { edges: null, why: 'closed' };
    const runs = splitRuns(segments, runStarts);
    if (!runs) return { edges: null, why: 'runs' };
    const contours: Float64Array[] = [];
    for (const run of runs) {
        if (run.length / 3 === 1) {
            contours.push(discContour(run[0], run[1], run[2], tolerance));
            continue;
        }
        const contour = runContour(run, tolerance);
        if (!contour) return { edges: null, why: 'taper' };
        contours.push(contour);
    }
    for (let i = 0; i < discs.length; i += 3) contours.push(discContour(discs[i], discs[i + 1], discs[i + 2], tolerance));
    for (const contour of contours) orientPositive(contour);
    const edges = unionEdges(contours);
    return edges ? { edges, why: null } : { edges: null, why: 'winding' };
}

function splitRuns(segments: Float64Array, runStarts: ArrayLike<number>): number[][] | null {
    const rows = segments.length / 6;
    if (rows > 0 && (runStarts.length === 0 || runStarts[0] !== 0)) return null;
    const runs: number[][] = [];
    for (let k = 0; k < runStarts.length; k++) {
        const first = runStarts[k], end = k + 1 < runStarts.length ? runStarts[k + 1] : rows;
        if (!(first >= 0) || !(end > first) || end > rows) return null;
        const run: number[] = [];
        for (let row = first; row < end; row++) {
            const i = 6 * row;
            if (row > first && Math.abs(run[run.length - 3] - segments[i]) + Math.abs(run[run.length - 2] - segments[i + 1]) > SAME_POINT) return null;
            pushVertex(run, segments[i], segments[i + 1], segments[i + 2]);
            pushVertex(run, segments[i + 3], segments[i + 4], segments[i + 5]);
        }
        runs.push(run);
    }
    return runs;
}

function pushVertex(run: number[], x: number, y: number, r: number): void {
    const n = run.length;
    if (n >= 3 && Math.abs(run[n - 3] - x) + Math.abs(run[n - 2] - y) <= SAME_POINT) {
        run[n - 1] = Math.max(run[n - 1], r);
        return;
    }
    run.push(x, y, r);
}

function runContour(run: number[], tolerance: number): Float64Array | null {
    const n = run.length / 3;
    const normals: [number, number][][] = [[], []];
    for (let i = 0; i < n - 1; i++) {
        const dx = run[3 * i + 3] - run[3 * i], dy = run[3 * i + 4] - run[3 * i + 1], len = Math.hypot(dx, dy);
        const ux = dx / len, uy = dy / len;
        const beta = (run[3 * i + 2] - run[3 * i + 5]) / len;
        if (!(Math.abs(beta) < 1)) return null;
        const alpha = Math.sqrt(1 - beta * beta);
        normals[0].push([-alpha * uy + beta * ux, alpha * ux + beta * uy]);
        normals[1].push([alpha * uy + beta * ux, -alpha * ux + beta * uy]);
    }
    const dir = (seg: number): [number, number] => [(run[3 * seg + 3] - run[3 * seg]), (run[3 * seg + 4] - run[3 * seg + 1])];
    const side = (k: number, seg: number): [number, number] => normals[k][seg];
    const left: number[] = [], right: number[] = [];
    const segLength = (seg: number): number => Math.hypot(run[3 * seg + 3] - run[3 * seg], run[3 * seg + 4] - run[3 * seg + 1]);
    for (const [k, into] of [[0, left], [1, right]] as const) {
        let usedAtStart = 0;
        const first = side(k, 0);
        into.push(run[0] + first[0] * run[2], run[1] + first[1] * run[2]);
        for (let i = 1; i < n - 1; i++) {
            const a = side(k, i - 1), b = side(k, i), r = run[3 * i + 2];
            const cross = a[0] * b[1] - a[1] * b[0];
            const outer = k === 0 ? cross < 0 : cross > 0;
            if (outer) {
                arcPoints(run[3 * i], run[3 * i + 1], r, Math.atan2(a[1], a[0]), Math.atan2(b[1], b[0]), into, tolerance);
                usedAtStart = 0;
            } else {
                const dot = a[0] * b[0] + a[1] * b[1];
                const kk = 1 + dot >= MIN_MITER ? r / (1 + dot) : 0;
                const mx = kk * (a[0] + b[0]), my = kk * (a[1] + b[1]);
                const [px, py] = dir(i - 1), [nx, ny] = dir(i), pl = segLength(i - 1), nl = segLength(i);
                const back = -(mx * px + my * py) / pl, ahead = (mx * nx + my * ny) / nl;
                if (kk > 0 && back + usedAtStart <= pl && ahead <= nl) {
                    usedAtStart = Math.max(0, ahead);
                    into.push(run[3 * i] + mx, run[3 * i + 1] + my);
                } else {
                    usedAtStart = 0;
                    into.push(run[3 * i] + a[0] * r, run[3 * i + 1] + a[1] * r, run[3 * i], run[3 * i + 1], run[3 * i] + b[0] * r, run[3 * i + 1] + b[1] * r);
                }
            }
        }
        const last = side(k, n - 2);
        into.push(run[3 * n - 3] + last[0] * run[3 * n - 1], run[3 * n - 2] + last[1] * run[3 * n - 1]);
    }
    const out: number[] = [];
    out.push(...left);
    const e = n - 1, df = dir(n - 2), ea = side(0, n - 2), eb = side(1, n - 2);
    capPoints(run[3 * e], run[3 * e + 1], run[3 * e + 2], Math.atan2(ea[1], ea[0]), Math.atan2(eb[1], eb[0]), Math.atan2(df[1], df[0]), out, tolerance);
    for (let k = right.length - 2; k >= 0; k -= 2) out.push(right[k], right[k + 1]);
    const d0 = dir(0), sr = side(1, 0), sl = side(0, 0);
    capPoints(run[0], run[1], run[2], Math.atan2(sr[1], sr[0]), Math.atan2(sl[1], sl[0]), Math.atan2(-d0[1], -d0[0]), out, tolerance);
    return Float64Array.from(out);
}

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, out: number[], tolerance: number): void {
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    sweepPoints(cx, cy, r, a0, sweep, out, tolerance);
}

function capPoints(cx: number, cy: number, r: number, a0: number, a1: number, outward: number, out: number[], tolerance: number): void {
    const base = normalizeAngle(a1 - a0);
    let best = base, bestGap = Infinity;
    for (const sweep of [base, base - 2 * Math.PI, base + 2 * Math.PI]) {
        if (Math.abs(sweep) > 1.5 * Math.PI) continue;
        const gap = Math.abs(normalizeAngle(a0 + sweep / 2 - outward));
        if (gap < bestGap) { bestGap = gap; best = sweep; }
    }
    sweepPoints(cx, cy, r, a0, best, out, tolerance);
}

function normalizeAngle(a: number): number {
    let x = a;
    while (x > Math.PI) x -= 2 * Math.PI;
    while (x <= -Math.PI) x += 2 * Math.PI;
    return x;
}

function sweepPoints(cx: number, cy: number, r: number, a0: number, sweep: number, out: number[], tolerance: number): void {
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / arcStep(r, tolerance)));
    for (let k = 0; k <= steps; k++) {
        const a = a0 + sweep * k / steps;
        out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
}

function discContour(x: number, y: number, r: number, tolerance: number): Float64Array {
    const points = Math.max(8, Math.ceil(2 * Math.PI / arcStep(r, tolerance)));
    const out = new Float64Array(2 * points);
    for (let k = 0; k < points; k++) {
        const a = 2 * Math.PI * k / points;
        out[2 * k] = x + r * Math.cos(a); out[2 * k + 1] = y + r * Math.sin(a);
    }
    return out;
}

function orientPositive(contour: Float64Array): void {
    const n = contour.length / 2;
    let area = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += contour[2 * i] * contour[2 * j + 1] - contour[2 * j] * contour[2 * i + 1];
    }
    if (area >= 0) return;
    for (let i = 0, j = n - 1; i < j; i++, j--) {
        const x = contour[2 * i], y = contour[2 * i + 1];
        contour[2 * i] = contour[2 * j]; contour[2 * i + 1] = contour[2 * j + 1];
        contour[2 * j] = x; contour[2 * j + 1] = y;
    }
}

function unionEdges(contours: readonly Float64Array[]): Float64Array | null {
    let total = 0;
    for (const contour of contours) total += contour.length >> 1;
    const ax = new Float64Array(total), ay = new Float64Array(total), bx = new Float64Array(total), by = new Float64Array(total);
    const first = new Int32Array(contours.length + 1);
    let at = 0;
    contours.forEach((contour, c) => {
        first[c] = at;
        const n = contour.length >> 1;
        for (let i = 0; i < n; i++, at++) {
            const j = (i + 1) % n;
            ax[at] = contour[2 * i]; ay[at] = contour[2 * i + 1]; bx[at] = contour[2 * j]; by[at] = contour[2 * j + 1];
        }
    });
    first[contours.length] = total;
    const order = Array.from({ length: total }, (_, i) => i);
    const minX = (e: number): number => Math.min(ax[e], bx[e]), maxX = (e: number): number => Math.max(ax[e], bx[e]);
    order.sort((p, q) => minX(p) - minX(q));
    const cuts: { t: number; x: number; y: number; delta: number }[][] = [];
    const adjacent = (e: number, f: number): boolean => {
        const ce = contourOf(first, e), cf = contourOf(first, f);
        if (ce !== cf) return false;
        const n = first[ce + 1] - first[ce], d = Math.abs(e - f);
        return d <= 1 || d === n - 1;
    };
    for (let p = 0; p < total; p++) {
        const e = order[p], eMax = maxX(e), eMinY = Math.min(ay[e], by[e]), eMaxY = Math.max(ay[e], by[e]);
        for (let q = p + 1; q < total; q++) {
            const f = order[q];
            if (minX(f) > eMax) break;
            if (Math.max(ay[f], by[f]) < eMinY || Math.min(ay[f], by[f]) > eMaxY || adjacent(e, f)) continue;
            const o1 = orient(ax[e], ay[e], bx[e], by[e], ax[f], ay[f]), o2 = orient(ax[e], ay[e], bx[e], by[e], bx[f], by[f]);
            if (!(o1 * o2 < 0)) continue;
            const o3 = orient(ax[f], ay[f], bx[f], by[f], ax[e], ay[e]), o4 = orient(ax[f], ay[f], bx[f], by[f], bx[e], by[e]);
            if (!(o3 * o4 < 0)) continue;
            const dex = bx[e] - ax[e], dey = by[e] - ay[e], dfx = bx[f] - ax[f], dfy = by[f] - ay[f];
            const den = dex * dfy - dey * dfx;
            const te = ((ax[f] - ax[e]) * dfy - (ay[f] - ay[e]) * dfx) / den, tf = ((ax[f] - ax[e]) * dey - (ay[f] - ay[e]) * dex) / den;
            const x = ax[e] + te * dex, y = ay[e] + te * dey;
            (cuts[e] ??= []).push({ t: te, x, y, delta: o4 > 0 ? 1 : -1 });
            (cuts[f] ??= []).push({ t: tf, x, y, delta: o2 > 0 ? 1 : -1 });
        }
    }
    const out: number[] = [];
    for (let c = 0; c < contours.length; c++) {
        const e0 = first[c], end = first[c + 1];
        if (end - e0 < 3) continue;
        const c0 = cuts[e0]; c0?.sort((p, q) => p.t - q.t);
        const t0 = c0?.length ? c0[0].t / 2 : 0.5;
        const dx = bx[e0] - ax[e0], dy = by[e0] - ay[e0];
        let w = windingAt(ax[e0] + t0 * dx + 1e-6 * dy, ay[e0] + t0 * dy - 1e-6 * dx, ax, ay, bx, by);
        const start = w;
        for (let e = e0; e < end; e++) {
            const list = cuts[e];
            if (list && e !== e0) list.sort((p, q) => p.t - q.t);
            let sx = ax[e], sy = ay[e];
            if (list) for (const cut of list) {
                if (w === 0) out.push(sx, sy, cut.x, cut.y);
                w += cut.delta;
                if (w < 0) return null;
                sx = cut.x; sy = cut.y;
            }
            if (w === 0) out.push(sx, sy, bx[e], by[e]);
        }
        if (w !== start) return null;
    }
    const balance = new Map<number, Map<number, number>>();
    const tally = (x: number, y: number, by: number): void => {
        let row = balance.get(x);
        if (!row) balance.set(x, row = new Map());
        row.set(y, (row.get(y) ?? 0) + by);
    };
    for (let i = 0; i < out.length; i += 4) { tally(out[i], out[i + 1], -1); tally(out[i + 2], out[i + 3], 1); }
    for (const row of balance.values()) for (const count of row.values()) if (count !== 0) return null;
    return Float64Array.from(out);
}

function contourOf(first: Int32Array, edge: number): number {
    let lo = 0, hi = first.length - 2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (first[mid] <= edge) lo = mid; else hi = mid - 1; }
    return lo;
}

function windingAt(x: number, y: number, ax: Float64Array, ay: Float64Array, bx: Float64Array, by: Float64Array): number {
    let w = 0;
    for (let e = 0; e < ax.length; e++) {
        const left = (bx[e] - ax[e]) * (y - ay[e]) - (x - ax[e]) * (by[e] - ay[e]);
        if (ay[e] <= y) { if (by[e] > y && left > 0) w++; }
        else if (by[e] <= y && left < 0) w--;
    }
    return w;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return Math.abs(v) < ORIENT_EPS ? 0 : Math.sign(v);
}
