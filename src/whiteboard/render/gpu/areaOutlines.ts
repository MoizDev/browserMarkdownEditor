/** Exact-area outlines for path shapes: the closed contours the exact-area kit sums (see whiteboard/render/inkAreaCells.ts).
 *
 * A fill is its flattened subpaths. A stroke is the outline of its flattened polyline: an open polyline is one contour, its left
 * side forward and its right side back, with its caps; a closed polyline (a ring) is two contours, the outer offset and the inner
 * offset reversed, so the signed sum is the ring's area. Joins follow canvas2d's rules: miter (bevelled past the miter limit),
 * bevel, round. Every builder returns null when the outline is not represented exactly: a dash, a degenerate or reversing polyline,
 * or a contour that overlaps itself (an inner offset of a tight bend). The caller then takes the coverage route and counts why.
 *
 * Coordinates are path-local (the units the path is flattened in); a caller maps them to device px. */
import type { Affine, PathCommand } from '../../../platform/types';
import type { Vec2 } from '../../geom/path';

/** A flattened subpath: its points, and whether it is closed. */
export interface Polyline { readonly points: readonly Vec2[]; readonly closed: boolean }
/** One contour: x, y pairs, closed (the last point joins the first). */
export type Contour = Float64Array;
export interface OutlineStyle { readonly width: number; readonly cap: 'butt' | 'round' | 'square'; readonly join: 'miter' | 'round' | 'bevel'; readonly miterLimit: number }

interface Dir { readonly x: number; readonly y: number }

const SAME = 1e-9;

/** The polyline without repeated points (and without a closing point repeated), or null when it is too short to bound an area. */
function distinct(points: readonly Vec2[], closed: boolean): Vec2[] | null {
    const out: Vec2[] = [];
    for (const p of points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        const last = out[out.length - 1];
        if (last && Math.abs(last.x - p.x) < SAME && Math.abs(last.y - p.y) < SAME) continue;
        out.push({ x: p.x, y: p.y });
    }
    if (closed && out.length > 1) {
        const first = out[0], last = out[out.length - 1];
        if (Math.abs(first.x - last.x) < SAME && Math.abs(first.y - last.y) < SAME) out.pop();
    }
    return out.length >= (closed ? 3 : 2) ? out : null;
}

/** The unit direction of each edge: m − 1 for an open polyline of m points, m for a closed one. Null on a zero-length edge. */
function directions(p: readonly Vec2[], closed: boolean): Dir[] | null {
    const count = closed ? p.length : p.length - 1;
    const out: Dir[] = [];
    for (let i = 0; i < count; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        if (!(len > 0)) return null;
        out.push({ x: dx / len, y: dy / len });
    }
    return out;
}

/** The offset of one edge's direction to side s (+1 left, −1 right) at distance h. */
const normal = (d: Dir, s: number, h: number): Dir => ({ x: -s * d.y * h, y: s * d.x * h });

/** Appends the points of an arc around `c` (radius h) from the vector `a` to the vector `b`, through the side of `mid`, excluding
 * both ends. The step keeps the chord within `tol`. */
function arc(c: Vec2, a: Dir, b: Dir, mid: Dir, h: number, tol: number, out: number[]): void {
    const ta = Math.atan2(a.y, a.x), tb = Math.atan2(b.y, b.x);
    let sweep = tb - ta;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep <= -Math.PI) sweep += 2 * Math.PI;
    const tm = ta + sweep / 2;
    if (Math.cos(tm) * mid.x + Math.sin(tm) * mid.y < 0) sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
    const step = tol > 0 && tol < h ? 2 * Math.acos(1 - tol / h) : Math.PI / 8;
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / step));
    for (let i = 1; i < n; i++) {
        const t = ta + (sweep * i) / n;
        out.push(c.x + h * Math.cos(t), c.y + h * Math.sin(t));
    }
}

/** The points of one vertex's join on side s, between the offsets of its incoming and outgoing edges. False when the join is not
 * representable (a reversal, whose offset is unbounded). */
function joinPoints(p: Vec2, ein: Dir, eout: Dir, s: number, h: number, style: OutlineStyle, tol: number, out: number[]): boolean {
    const nin = normal(ein, s, h), nout = normal(eout, s, h);
    const cross = ein.x * eout.y - ein.y * eout.x, dot = ein.x * eout.x + ein.y * eout.y;
    if (Math.abs(cross) < 1e-12 && dot > 0) { out.push(p.x + nin.x, p.y + nin.y); return true; }
    const denom = 1 + dot;
    if (denom < 1e-9) return false;
    // The offset lines meet here: the inner side's corner, and the outer side's miter tip.
    const mx = p.x + (nin.x + nout.x) / denom, my = p.y + (nin.y + nout.y) / denom;
    if (s * cross > 0) { out.push(mx, my); return true; }
    if (style.join === 'miter' && Math.hypot(mx - p.x, my - p.y) <= style.miterLimit * h) { out.push(mx, my); return true; }
    if (style.join === 'round') {
        out.push(p.x + nin.x, p.y + nin.y);
        arc(p, nin, nout, { x: nin.x + nout.x, y: nin.y + nout.y }, h, tol, out);
        out.push(p.x + nout.x, p.y + nout.y);
        return true;
    }
    out.push(p.x + nin.x, p.y + nin.y, p.x + nout.x, p.y + nout.y);
    return true;
}

/** One side of a polyline: a closed ring's offset (every vertex joins), or an open polyline's offset from its start to its end. */
function sideOf(p: readonly Vec2[], d: readonly Dir[], closed: boolean, s: number, h: number, style: OutlineStyle, tol: number): number[] | null {
    const out: number[] = [];
    const m = p.length;
    if (closed) {
        for (let k = 0; k < m; k++) if (!joinPoints(p[k], d[(k - 1 + m) % m], d[k], s, h, style, tol, out)) return null;
        return out;
    }
    const first = normal(d[0], s, h);
    out.push(p[0].x + first.x, p[0].y + first.y);
    for (let k = 1; k < m - 1; k++) if (!joinPoints(p[k], d[k - 1], d[k], s, h, style, tol, out)) return null;
    const last = normal(d[m - 2], s, h);
    out.push(p[m - 1].x + last.x, p[m - 1].y + last.y);
    return out;
}

/** Twice the signed area of a flat x, y list. */
export function signedArea2(points: ArrayLike<number>): number {
    const n = points.length / 2;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        sum += points[2 * i] * points[2 * j + 1] - points[2 * j] * points[2 * i + 1];
    }
    return sum;
}

function reversed(points: readonly number[]): number[] {
    const out: number[] = new Array(points.length);
    const n = points.length / 2;
    for (let i = 0; i < n; i++) { out[2 * i] = points[2 * (n - 1 - i)]; out[2 * i + 1] = points[2 * (n - 1 - i) + 1]; }
    return out;
}

/** Whether (px, py), on the line through a and b, lies within the segment's box (its ends included). */
function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
    return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

/** Whether the closed contour does not cross or touch itself (non-adjacent edges apart, no zero-area spike). */
export function simpleContour(points: ArrayLike<number>): boolean {
    const n = points.length / 2;
    if (n < 3) return false;
    const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (let i = 0; i < n; i++) {
        const ax = points[2 * i], ay = points[2 * i + 1], bx = points[2 * ((i + 1) % n)], by = points[2 * ((i + 1) % n) + 1];
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const cx = points[2 * j], cy = points[2 * j + 1], dx = points[2 * ((j + 1) % n)], dy = points[2 * ((j + 1) % n) + 1];
            const d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by);
            const d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
            if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return false;
            // A zero orientation is a touch only where the point lies on the other edge: two edges on one line that do not meet
            // (a star's two arms on the line through its shoulders, an up arrow's two shoulders) are apart. Counted as touching, the
            // outline of every such shape went to the 4x coverage kit: its edges in quarter steps (the star 1349 edge px past the truth
            // bar, max 64; gpu-f1's truth check, DPR 2 dark).
            if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay) || d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)
                || d3 === 0 && onSegment(ax, ay, bx, by, cx, cy) || d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return false;
        }
    }
    return true;
}

function flat(points: readonly number[]): Contour { return Float64Array.from(points); }

/** The fill contours of subpaths, or null when one is not a simple contour. An open subpath closes by its chord (the fill's rule). */
export function fillContours(subpaths: readonly (readonly Vec2[])[]): Contour[] | null {
    const out: Contour[] = [];
    for (const sub of subpaths) {
        const pts = distinct(sub, true);
        if (!pts) return null;
        const list: number[] = [];
        for (const p of pts) list.push(p.x, p.y);
        if (!simpleContour(list)) return null;
        out.push(flat(list));
    }
    return out;
}

/** The stroke's contours for the polylines, in path-local units at half-width `style.width / 2`. A closed polyline gives its outer
 * offset and its inner offset reversed (an annulus, opposite signs); an open one gives one contour around its caps. Null when a
 * contour is not representable exactly (see the file's notes). The caller checks nesting over the device contours. */
export function strokeContours(lines: readonly Polyline[], style: OutlineStyle, tol: number): Contour[] | null {
    const h = style.width / 2;
    if (!(h > 0) || !Number.isFinite(h)) return null;
    const out: Contour[] = [];
    for (const line of lines) {
        const pts = distinct(line.points, line.closed);
        if (!pts) return null;
        const d = directions(pts, line.closed);
        if (!d) return null;
        if (line.closed) {
            const left = sideOf(pts, d, true, +1, h, style, tol), right = sideOf(pts, d, true, -1, h, style, tol);
            if (!left || !right || !simpleContour(left) || !simpleContour(right)) return null;
            // The larger offset is the outer contour; the inner one runs the other way, so the pair sums to the ring.
            const leftArea = Math.abs(signedArea2(left)), rightArea = Math.abs(signedArea2(right));
            const outer = leftArea >= rightArea ? left : right, inner = leftArea >= rightArea ? right : left;
            out.push(flat(outer), flat(reversed(inner)));
            continue;
        }
        const outline = openOutline(pts, d, h, style, tol);
        if (!outline || !simpleContour(outline)) return null;
        out.push(flat(outline));
    }
    return out;
}

/** One open polyline's stroke outline: its left side forward, the end cap, its right side back, the start cap. */
function openOutline(p: readonly Vec2[], d: readonly Dir[], h: number, style: OutlineStyle, tol: number): number[] | null {
    const left = sideOf(p, d, false, +1, h, style, tol), right = sideOf(p, d, false, -1, h, style, tol);
    if (!left || !right) return null;
    const out: number[] = left.slice();
    const end = p[p.length - 1], ef = d[d.length - 1];
    const nl = normal(ef, +1, h), nr = normal(ef, -1, h);
    if (style.cap === 'square') out.push(end.x + nl.x + ef.x * h, end.y + nl.y + ef.y * h, end.x + nr.x + ef.x * h, end.y + nr.y + ef.y * h);
    else if (style.cap === 'round') arc(end, nl, nr, ef, h, tol, out);
    const rightRev = reversed(right);
    for (const v of rightRev) out.push(v);
    const start = p[0], sf = d[0];
    const sl = normal(sf, +1, h), sr = normal(sf, -1, h);
    const back = { x: -sf.x, y: -sf.y };
    if (style.cap === 'square') out.push(start.x + sr.x + back.x * h, start.y + sr.y + back.y * h, start.x + sl.x + back.x * h, start.y + sl.y + back.y * h);
    else if (style.cap === 'round') arc(start, sr, sl, back, h, tol, out);
    return out;
}

/** An evenodd clip shaped as one convex outer polygon minus convex holes inside it, disjoint (a connector's body cut around its label):
 * its polygons mapped by `toLocal` into the clipped item's own units, or null for any other clip. Straight segments only. */
export interface CutClip { readonly outer: Contour; readonly holes: readonly Contour[] }
export function cutClipOf(d: readonly PathCommand[], fillRule: 'nonzero' | 'evenodd', toLocal: Affine): CutClip | null {
    if (fillRule !== 'evenodd') return null;
    const polys: number[][] = [];
    let cur: number[] | null = null;
    const [a, b, c, e, f, g] = toLocal;
    for (const cmd of d) {
        if (cmd[0] === 'M') { cur = [a * cmd[1] + c * cmd[2] + f, b * cmd[1] + e * cmd[2] + g]; polys.push(cur); }
        else if (cmd[0] === 'L' && cur) cur.push(a * cmd[1] + c * cmd[2] + f, b * cmd[1] + e * cmd[2] + g);
        else if (cmd[0] === 'Z') cur = null;
        else return null;
    }
    if (polys.length < 2) return null;
    const flats: Contour[] = [];
    for (const raw of polys) {
        const pts = distinct(Array.from({ length: raw.length / 2 }, (_, i) => ({ x: raw[2 * i], y: raw[2 * i + 1] })), true);
        if (!pts || !convex(pts)) return null;
        flats.push(Float64Array.from(pts.flatMap(p => [p.x, p.y])));
    }
    const [outer, ...holes] = flats;
    const boxes = holes.map(boxOf);
    for (let i = 0; i < holes.length; i++) {
        for (let k = 0; k < holes[i].length; k += 2) if (!insideConvex(outer, holes[i][k], holes[i][k + 1])) return null;
        for (let j = 0; j < i; j++) if (boxes[i][0] < boxes[j][2] && boxes[j][0] < boxes[i][2] && boxes[i][1] < boxes[j][3] && boxes[j][1] < boxes[i][3]) return null;
    }
    return { outer, holes };
}

/** The exact-area contours of `contours` (exact by themselves: simple, nesting with opposite signs) under `cut`: each contour's part
 * inside the outer polygon, and its part inside each hole reversed, so the signed sum is the item inside the clip, nothing masked. The
 * parts may run back and forth along a clip edge; those runs cancel in the sum, which is all the exact-area kit takes. */
export function cutContours(contours: readonly Contour[], cut: CutClip): Contour[] {
    const out: Contour[] = [];
    for (const contour of contours) {
        const inside = clipConvex(contour, cut.outer);
        if (inside.length < 6) continue;
        out.push(flat(inside));
        for (const hole of cut.holes) {
            const removed = clipConvex(Float64Array.from(inside), hole);
            if (removed.length >= 6) out.push(flat(reversed(removed)));
        }
    }
    return out;
}

function convex(pts: readonly Vec2[]): boolean {
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length], r = pts[(i + 2) % pts.length];
        const z = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
        if (z === 0) continue;
        if (sign === 0) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
    }
    return sign !== 0;
}
function boxOf(poly: Contour): [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) { x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]); y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]); }
    return [x0, y0, x1, y1];
}
/** Inside or on a convex polygon of either orientation. */
function insideConvex(poly: Contour, x: number, y: number): boolean {
    const n = poly.length / 2, sign = Math.sign(signedArea2(poly));
    for (let i = 0; i < n; i++) {
        const ax = poly[2 * i], ay = poly[2 * i + 1], bx = poly[2 * ((i + 1) % n)], by = poly[2 * ((i + 1) % n) + 1];
        if (((bx - ax) * (y - ay) - (by - ay) * (x - ax)) * sign < 0) return false;
    }
    return true;
}
/** Sutherland-Hodgman: the part of `subject` inside the convex `clipper`. For a non-convex subject the result may run along the
 * clipper's edges in both directions; those runs cancel in a signed area sum, which is all the exact-area kit takes. */
function clipConvex(subject: Contour, clipper: Contour): number[] {
    let out: number[] = Array.from(subject);
    const n = clipper.length / 2, sign = Math.sign(signedArea2(clipper));
    for (let i = 0; i < n && out.length >= 6; i++) {
        const ax = clipper[2 * i], ay = clipper[2 * i + 1], bx = clipper[2 * ((i + 1) % n)], by = clipper[2 * ((i + 1) % n) + 1];
        const side = (x: number, y: number) => ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) * sign;
        const input = out; out = [];
        const m = input.length / 2;
        for (let k = 0; k < m; k++) {
            const px = input[2 * k], py = input[2 * k + 1], qx = input[2 * ((k + 1) % m)], qy = input[2 * ((k + 1) % m) + 1];
            const sp = side(px, py), sq = side(qx, qy);
            if (sp >= 0) out.push(px, py);
            if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push(px + t * (qx - px), py + t * (qy - py)); }
        }
    }
    return out;
}
