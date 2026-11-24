import type { LineCap, LineJoin, PathCommand } from '../../platform/types';
import { flattenCubic } from '../geom/flatten';
import type { Vec2 } from '../geom/path';

/** Canvas stroke semantics as a UNION of convex pieces: every segment rectangle, join wedge, cap and
 * dash interval is convex and drawn with a union stencil, so overlap never counts twice. Geometry is
 * built in local units (canvas strokes are transformed with the path), then rebased to `origin`. */
export interface StrokeGeometryOptions {
    /** Local line width, > 0. */
    readonly width: number;
    readonly cap: LineCap;
    readonly join: LineJoin;
    readonly miterLimit: number;
    /** Dash lengths in local units (even count, non-negative) and phase; absent means solid. */
    readonly dash?: Readonly<{ array: readonly number[]; phase: number }>;
    /** Maximum deviation of flattened curves and round outlines, in local units. */
    readonly tolerance: number;
    readonly origin: readonly [x: number, y: number];
    readonly maxTriangles?: number;
}

export interface StrokeTriangles {
    /** Origin-relative triangles, six values each; every triangle belongs to the union. */
    readonly triangles: Float64Array;
    readonly bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
}

const MAX_POINTS = 65_536, MAX_TRIANGLES_DEFAULT = 262_144;
const MIN_CIRCLE_SEGMENTS = 8, MAX_CIRCLE_SEGMENTS = 128;

export interface Polyline { points: Vec2[]; closed: boolean }

/** The subpaths of a command list, flattened: the stroke route's outline (the area route's contours) and its triangles share them. */
export function flattenPolylines(commands: readonly PathCommand[], tolerance: number): Polyline[] | null {
    if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new RangeError('Invalid stroke flattening tolerance');
    const lines: Polyline[] = [];
    let current: Polyline | null = null, closedStart: Vec2 | null = null, count = 0;
    const add = (point: Vec2) => {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Non-finite stroke vertex');
        if (!current) {
            // Segments after a closepath start from the subpath's first point (canvas semantics).
            if (!closedStart) throw new RangeError('Path segment before move');
            current = { points: [closedStart], closed: false };
            lines.push(current); count++;
        }
        current.points.push(point); count++;
    };
    for (const command of commands) {
        switch (command[0]) {
            case 'M': {
                current = { points: [{ x: command[1], y: command[2] }], closed: false };
                lines.push(current); count++;
                closedStart = current.points[0];
                break;
            }
            case 'L': add({ x: command[1], y: command[2] }); break;
            case 'C': {
                const last = current ? current.points[current.points.length - 1] : closedStart;
                if (!last) throw new RangeError('Path segment before move');
                const pieces = flattenCubic({ p0: last, p1: { x: command[1], y: command[2] },
                    p2: { x: command[3], y: command[4] }, p3: { x: command[5], y: command[6] } }, tolerance);
                for (const point of pieces.slice(1)) add(point);
                break;
            }
            case 'Z':
                if (current) { current.closed = true; closedStart = current.points[0]; current = null; }
                break;
        }
        if (count > MAX_POINTS) return null;
    }
    return lines;
}

/** Consecutive duplicates vanish; a closing duplicate of the first point also vanishes. */
function clean(points: readonly Vec2[], closed: boolean): Vec2[] {
    const out: Vec2[] = [];
    for (const point of points) {
        const previous = out[out.length - 1];
        if (!previous || previous.x !== point.x || previous.y !== point.y) out.push(point);
    }
    if (closed && out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
    return out;
}

/** Dash intervals along a polyline, each an open piece. Phase and pattern follow canvas: a total
 * phase is reduced modulo the pattern length, and zero-length on-intervals become dots. */
/** Dash steps one stroke may take, across all its subpaths. A dash of 1e-6 on a 1000-unit line is 5×10⁸ steps, each a new
 * interval, before any triangle exists, so the count is bounded where the intervals are made, not only at the triangles. */
const MAX_DASH_STEPS = 262_144;
interface DashBudget { left: number }
function dashPieces(line: Polyline, array: readonly number[], phase: number, budget: DashBudget): Polyline[] {
    const total = array.reduce((sum, value) => sum + value, 0);
    let index = 0, p = phase % total;
    if (p < 0) p += total;
    while (p >= array[index]) { p -= array[index]; index = (index + 1) % array.length; }
    let remaining = array[index] - p, on = index % 2 === 0;
    const pieces: Polyline[] = [];
    let current: Vec2[] | null = on ? [line.points[0]] : null;
    const pts = line.points;
    const segments = line.closed ? pts.length : pts.length - 1;
    for (let s = 0; s < segments; s++) {
        const a = pts[s], b = pts[(s + 1) % pts.length];
        const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
        if (!(length > 0)) continue;
        const ux = dx / length, uy = dy / length;
        let t = 0;
        while (t < length) {
            if (--budget.left < 0) throw new RangeError('Stroke dash budget exceeded');
            const at = (value: number): Vec2 => ({ x: a.x + ux * value, y: a.y + uy * value });
            if (remaining <= 0) {
                if (on) { if (current) pieces.push({ points: current, closed: false }); current = null; }
                else current = [at(t)];
                on = !on; index = (index + 1) % array.length; remaining = array[index];
                continue;
            }
            const step = Math.min(remaining, length - t);
            t += step; remaining -= step;
            if (on && current) current.push(at(t));
        }
    }
    if (on && current) pieces.push({ points: current, closed: false });
    return pieces;
}

/** Strokes are emitted in local units and rebased to origin. Circles are inscribed polygons whose
 * sagitta is within tolerance (design §5.1), so the union never bulges past the canonical arc. */
class Sink {
    /** Origin-relative vertices, two values each, in a buffer that doubles as it fills: the outline is copied out once at the end
     * (`count` values are in use), where a boxed number array was copied at the end and a literal array was built per triangle. */
    private values = new Float64Array(0);
    private count = 0;
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    constructor(private readonly ox: number, private readonly oy: number, private readonly limit: number) {}
    tri(a: Vec2, b: Vec2, c: Vec2): void {
        if (this.count / 6 >= this.limit) throw new RangeError('Stroke triangle budget exceeded');
        this.vertex(a); this.vertex(b); this.vertex(c);
    }
    private vertex(p: Vec2): void {
        const x = p.x - this.ox, y = p.y - this.oy;
        if (this.count + 2 > this.values.length) {
            const grown = new Float64Array(Math.max(96, this.values.length * 2));
            grown.set(this.values.subarray(0, this.count));
            this.values = grown;
        }
        this.values[this.count] = x; this.values[this.count + 1] = y; this.count += 2;
        this.minX = Math.min(this.minX, x); this.maxX = Math.max(this.maxX, x);
        this.minY = Math.min(this.minY, y); this.maxY = Math.max(this.maxY, y);
    }
    /** The emitted triangles as an exact-size copy. */
    triangles(): Float64Array { return this.values.slice(0, this.count); }
    get size(): number { return this.count; }
    quad(a: Vec2, b: Vec2, c: Vec2, d: Vec2): void { this.tri(a, b, c); this.tri(a, c, d); }
    circle(centre: Vec2, radius: number, tolerance: number): void {
        const ratio = radius > tolerance ? 1 - tolerance / radius : -1;
        const half = Math.acos(Math.max(-1, Math.min(1, ratio)));
        const segments = Math.min(MAX_CIRCLE_SEGMENTS, Math.max(MIN_CIRCLE_SEGMENTS, half > 0 ? Math.ceil(Math.PI / half) : MAX_CIRCLE_SEGMENTS));
        let prev: Vec2 = { x: centre.x + radius, y: centre.y };
        for (let i = 1; i <= segments; i++) {
            const angle = 2 * Math.PI * i / segments;
            const next: Vec2 = { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
            this.tri(centre, prev, next);
            prev = next;
        }
    }
}

function emitPolyline(sink: Sink, points: readonly Vec2[], closed: boolean, options: StrokeGeometryOptions): void {
    const h = options.width / 2, tol = options.tolerance;
    if (points.length === 1) {
        const p = points[0];
        if (options.cap === 'round') sink.circle(p, h, tol);
        else if (options.cap === 'square') sink.quad({ x: p.x - h, y: p.y - h }, { x: p.x + h, y: p.y - h }, { x: p.x + h, y: p.y + h }, { x: p.x - h, y: p.y + h });
        return;
    }
    const n = points.length;
    const segmentCount = closed ? n : n - 1;
    const dirs: Vec2[] = [];
    for (let s = 0; s < segmentCount; s++) {
        const a = points[s], b = points[(s + 1) % n];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
        dirs.push(d);
        const nx = -d.y * h, ny = d.x * h;
        sink.quad({ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny });
    }
    // Joins: every vertex of a closed outline, interior vertices of an open one.
    // Open outlines join only interior vertices; closed outlines join every vertex, including the first.
    const first = closed ? 0 : 1, last = closed ? n : n - 1;
    for (let i = first; i < last; i++) {
        const v = points[i];
        const dIn = dirs[(i - 1 + segmentCount) % segmentCount], dOut = dirs[i % segmentCount];
        if (options.join === 'round') { sink.circle(v, h, tol); continue; }
        const cross = dIn.x * dOut.y - dIn.y * dOut.x, dot = dIn.x * dOut.x + dIn.y * dOut.y;
        if (Math.abs(cross) < 1e-12 && dot > 0) continue;  // collinear: the rectangles already meet
        // Outer side of the turn is opposite the turning direction; normals have length h.
        const side = cross > 0 ? -1 : 1;
        const n1 = { x: side * -dIn.y * h, y: side * dIn.x * h }, n2 = { x: side * -dOut.y * h, y: side * dOut.x * h };
        // k = 1 + cos φ, φ the angle between the two normals. k → 0 is a reversal: the wedge has no area.
        const k = 1 + (n1.x * n2.x + n1.y * n2.y) / (h * h);
        if (k <= 1e-12) continue;
        const bevel = (): void => sink.tri(v, { x: v.x + n1.x, y: v.y + n1.y }, { x: v.x + n2.x, y: v.y + n2.y });
        if (options.join === 'bevel') { bevel(); continue; }
        // Miter length / width = 1 / cos(φ/2) = sqrt(2 / k); beyond the limit canvas falls back to bevel.
        if (Math.sqrt(2 / k) > options.miterLimit) { bevel(); continue; }
        // Tip of the miter along the bisector: v + (n1 + n2) / k for normals of length h.
        const tip = { x: v.x + (n1.x + n2.x) / k, y: v.y + (n1.y + n2.y) / k };
        sink.quad(v, { x: v.x + n1.x, y: v.y + n1.y }, tip, { x: v.x + n2.x, y: v.y + n2.y });
    }
    if (!closed) {
        const d0 = dirs[0], dn = dirs[segmentCount - 1];
        const p0 = points[0], pn = points[n - 1];
        if (options.cap === 'round') { sink.circle(p0, h, tol); sink.circle(pn, h, tol); }
        else if (options.cap === 'square') {
            const n0 = { x: -d0.y * h, y: d0.x * h }, nn = { x: -dn.y * h, y: dn.x * h };
            sink.quad({ x: p0.x + n0.x, y: p0.y + n0.y }, { x: p0.x + n0.x - d0.x * h, y: p0.y + n0.y - d0.y * h },
                { x: p0.x - n0.x - d0.x * h, y: p0.y - n0.y - d0.y * h }, { x: p0.x - n0.x, y: p0.y - n0.y });
            sink.quad({ x: pn.x + nn.x, y: pn.y + nn.y }, { x: pn.x + nn.x + dn.x * h, y: pn.y + nn.y + dn.y * h },
                { x: pn.x - nn.x + dn.x * h, y: pn.y - nn.y + dn.y * h }, { x: pn.x - nn.x, y: pn.y - nn.y });
        }
    }
}

/** Stroke outline as convex pieces, or null when the work bound is exceeded (the caller then uses the
 * exact canonical raster for the item). Degenerate input is validated, never silently repaired. */
export function pathStrokeTriangles(commands: readonly PathCommand[], options: StrokeGeometryOptions): StrokeTriangles | null {
    if (!(options.width > 0) || !Number.isFinite(options.width)) throw new RangeError('Invalid stroke width');
    if (!Number.isFinite(options.miterLimit) || options.miterLimit <= 0) throw new RangeError('Invalid stroke miter limit');
    const [ox, oy] = options.origin;
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) throw new RangeError('Stroke origin must be finite');
    const dash = options.dash;
    if (dash) {
        if (!Number.isFinite(dash.phase) || dash.array.some(value => !Number.isFinite(value) || value < 0)) throw new RangeError('Invalid dash pattern');
    }
    const lines = flattenPolylines(commands, options.tolerance);
    if (!lines) return null;
    const sink = new Sink(ox, oy, options.maxTriangles ?? MAX_TRIANGLES_DEFAULT);
    const solid = !dash || dash.array.reduce((sum, value) => sum + value, 0) <= 0;
    const dashBudget: DashBudget = { left: MAX_DASH_STEPS };
    try {
        for (const line of lines) {
            const points = clean(line.points, line.closed);
            const pieceList: Polyline[] = solid ? [{ points, closed: line.closed }]
                : dashPieces({ points, closed: line.closed }, dash!.array, dash!.phase, dashBudget);
            for (const piece of pieceList) {
                if (!piece.points.length) continue;
                emitPolyline(sink, clean(piece.points, piece.closed), piece.closed, options);
            }
        }
    } catch (error) {
        if (error instanceof RangeError && /budget/.test(error.message)) return null;
        throw error;
    }
    if (!sink.size) return { triangles: new Float64Array(0), bounds: { x0: 0, y0: 0, x1: 0, y1: 0 } };
    return { triangles: sink.triangles(),
        bounds: { x0: sink.minX, y0: sink.minY, x1: sink.maxX, y1: sink.maxY } };
}
