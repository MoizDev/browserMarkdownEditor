import type { Rect } from '../../platform/types';
import type { FigureShape } from '../model/styles';
import type { PathOp, Vec2 } from './path';

// geometry.md §3, F-FIG-001: these are independent unit-box authoring recipes.
const P = (x: number, y: number): Vec2 => ({ x, y });

function polygon(points: readonly Vec2[]): readonly PathOp[] {
    return [
        { op: 'M', p: points[0] },
        ...points.slice(1).map((p): PathOp => ({ op: 'L', p })),
        { op: 'Z' },
    ];
}

function fit(points: readonly Vec2[]): readonly Vec2[] {
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
    return points.map(p => P((p.x - x0) / w, (p.y - y0) / h));
}

function radial(count: number, alternate: number | null = null): readonly Vec2[] {
    const total = alternate === null ? count : count * 2;
    return fit(Array.from({ length: total }, (_, i) => {
        const angle = -Math.PI / 2 + i * 2 * Math.PI / total;
        const r = alternate !== null && i % 2 ? alternate : 1;
        return P(r * Math.cos(angle), r * Math.sin(angle));
    }));
}

const RIGHT = [P(0, .3), P(.6, .3), P(.6, 0), P(1, .5), P(.6, 1), P(.6, .7), P(0, .7)];

export interface CreationFitProfile {
    readonly xScale: number; readonly yScale: number;
    readonly xInset: number; readonly yInset: number;
}

// FIG/creation-whiteboard.json, Star/Cloud/Heart drag: requested 120×80 divided by stored box;
// origin offsets locate that requested rectangle inside the stored box. Clicks use separate defaults.
export const CREATION_FIT: Readonly<Partial<Record<FigureShape, CreationFitProfile>>> = {
    star: { xScale: 120 / 120.28574477856256, yScale: 80 / 80.72700079076078,
        xInset: .1428723892813 / 120.28574477856256, yInset: 0 },
    cloud: { xScale: 1, yScale: 80 / 87.50680490356174,
        xInset: 0, yInset: 3.75340245178086 / 87.50680490356174 },
    heart: { xScale: 1, yScale: 80 / 80.44688874921506,
        xInset: 0, yInset: .4468887492151 / 80.44688874921506 },
};

/** Fit a tight requested box without conflating it with the persisted logical box. */
export function fitFigureCreation(shape: FigureShape, requested: Rect): Rect {
    const { x, y, width: w, height: h } = requested;
    if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) throw new RangeError('Invalid requested figure box');
    const profile = CREATION_FIT[shape];
    const width = Math.max(1, w / (profile?.xScale ?? 1));
    const height = Math.max(1, h / (profile?.yScale ?? 1));
    return { x: x - width * (profile?.xInset ?? 0), y: y - height * (profile?.yInset ?? 0), width, height };
}

/** The polygonal forms; curved forms require their analytic outlines. */
export function polygonFigure(shape: FigureShape): readonly (readonly PathOp[])[] | null {
    let points: readonly Vec2[];
    switch (shape) {
        case 'rectangle': case 'x-box': case 'check-box':
            points = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)]; break;
        case 'triangle': points = [P(.5, 0), P(1, 1), P(0, 1)]; break;
        case 'diamond': points = [P(.5, 0), P(1, .5), P(.5, 1), P(0, .5)]; break;
        case 'pentagon': points = radial(5); break;
        case 'hexagon': points = radial(6); break;
        case 'octagon': points = radial(8); break;
        case 'star': points = radial(5, (3 - Math.sqrt(5)) / 2); break;
        case 'rhombus': points = [P(.25, 0), P(1, 0), P(.75, 1), P(0, 1)]; break;
        case 'rhombus-2': points = [P(0, 0), P(.75, 0), P(1, 1), P(.25, 1)]; break;
        case 'trapezoid': points = [P(.25, 0), P(.75, 0), P(1, 1), P(0, 1)]; break;
        case 'arrow-right': points = RIGHT; break;
        case 'arrow-left': points = RIGHT.map(p => P(1 - p.x, 1 - p.y)); break;
        case 'arrow-up': points = RIGHT.map(p => P(p.y, 1 - p.x)); break;
        case 'arrow-down': points = RIGHT.map(p => P(1 - p.y, p.x)); break;
        default: return null;
    }
    const outer = polygon(points);
    if (shape === 'x-box') return [outer,
        [{ op: 'M', p: P(.12, .12) }, { op: 'L', p: P(.88, .88) }],
        [{ op: 'M', p: P(.88, .12) }, { op: 'L', p: P(.12, .88) }]];
    if (shape === 'check-box') return [outer,
        [{ op: 'M', p: P(.18, .52) }, { op: 'L', p: P(.42, .76) }, { op: 'L', p: P(.84, .24) }]];
    return [outer];
}

/** Parametric contours stay analytic until a consumer asks for bounded flattening. */
export type CurvedFigure =
    | Readonly<{ kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }>
    | Readonly<{ kind: 'stadium'; width: number; height: number; radius: number }>
    | Readonly<{ kind: 'cloud'; width: number; height: number; yExtent: number }>
    | Readonly<{ kind: 'path'; ops: readonly PathOp[] }>;

function cubicValue(a: number, b: number, c: number, d: number, t: number): number {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function cubicExtrema(a: number, b: number, c: number, d: number): number[] {
    const qa = -a + 3 * b - 3 * c + d, qb = 2 * (a - 2 * b + c), qc = b - a;
    if (Math.abs(qa) < 1e-14) return Math.abs(qb) < 1e-14 ? [] : [-qc / qb].filter(t => t > 0 && t < 1);
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return [];
    const root = Math.sqrt(disc);
    return [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)].filter(t => t > 0 && t < 1);
}

function heart(width: number, height: number): readonly PathOp[] {
    const curves = [
        [P(.5, .25), P(.12, -.12), P(-.2, .42), P(.5, 1)],
        [P(.5, 1), P(1.2, .42), P(.88, -.12), P(.5, .25)],
    ];
    const xs: number[] = [], ys: number[] = [];
    for (const [a, b, c, d] of curves) {
        for (const t of [0, 1, ...cubicExtrema(a.x, b.x, c.x, d.x)]) xs.push(cubicValue(a.x, b.x, c.x, d.x, t));
        for (const t of [0, 1, ...cubicExtrema(a.y, b.y, c.y, d.y)]) ys.push(cubicValue(a.y, b.y, c.y, d.y, t));
    }
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
    const normalized = (p: Vec2): Vec2 => P(width * (p.x - x0) / w, height * (p.y - y0) / h);
    return [{ op: 'M', p: normalized(curves[0][0]) }, ...curves.map(([, c1, c2, p]): PathOp =>
        ({ op: 'C', c1: normalized(c1), c2: normalized(c2), p: normalized(p) })), { op: 'Z' }];
}

// The first upper lobe's maximum is bracketed away from the central y-axis minimum.
function cloudYExtent(): number {
    const slope = (t: number): number => Math.cos(t) * (1 + .08 * Math.cos(10 * t)) - .8 * Math.sin(t) * Math.sin(10 * t);
    let lo = 2 * Math.PI / 5, hi = Math.PI / 2 - Math.PI / 100;
    for (let i = 0; i < 55; i++) {
        const mid = (lo + hi) / 2;
        if (slope(mid) > 0) lo = mid; else hi = mid;
    }
    const t = (lo + hi) / 2;
    return (1 + .08 * Math.cos(10 * t)) * Math.sin(t);
}
const CLOUD_Y_EXTENT = cloudYExtent();

export function curvedFigure(shape: FigureShape, width: number, height: number): CurvedFigure | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) throw new RangeError('Invalid figure box');
    switch (shape) {
        case 'ellipse': return { kind: 'ellipse', cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2 };
        case 'oval': return { kind: 'stadium', width, height, radius: Math.min(width, height) / 2 };
        case 'cloud': return { kind: 'cloud', width, height, yExtent: CLOUD_Y_EXTENT };
        case 'heart': return { kind: 'path', ops: heart(width, height) };
        default: return null;
    }
}

export function placeFigurePath(ops: readonly PathOp[], width: number, height: number,
    flipX: boolean, flipY: boolean, shape?: FigureShape): readonly PathOp[] {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) throw new RangeError('Invalid figure box');
    const fit = shape ? CREATION_FIT[shape] : undefined;
    const place = (p: Vec2): Vec2 => {
        const x = fit ? fit.xInset + fit.xScale * p.x : p.x;
        const y = fit ? fit.yInset + fit.yScale * p.y : p.y;
        return P((flipX ? 1 - x : x) * width, (flipY ? 1 - y : y) * height);
    };
    return ops.map(op => {
        switch (op.op) {
            case 'M': case 'L': return { op: op.op, p: place(op.p) };
            case 'C': return { op: 'C', c1: place(op.c1), c2: place(op.c2), p: place(op.p) };
            case 'Z': return op;
        }
    });
}

export function cloudPoint(cloud: Extract<CurvedFigure, { kind: 'cloud' }>, theta: number): Vec2 {
    const r = 1 + .08 * Math.cos(10 * theta);
    return P(cloud.width * (r * Math.cos(theta) / 1.08 + 1) / 2,
        cloud.height * (r * Math.sin(theta) / cloud.yExtent + 1) / 2);
}

/** Hermite cubics with an explicit fourth-derivative error bound, emitted lazily. */
export function* cloudPath(cloud: Extract<CurvedFigure, { kind: 'cloud' }>, tolerance: number,
    maxPieces: number): Generator<PathOp> {
    if (!Number.isFinite(tolerance) || tolerance <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) {
        throw new RangeError('Invalid cloud realization budget');
    }
    // Product-to-sum gives frequencies 1, 9 and 11; this bounds both fourth derivatives.
    const fourth = 1 + .04 * (11 ** 4 + 9 ** 4);
    const scale = Math.max(cloud.width / (2 * 1.08), cloud.height / (2 * cloud.yExtent));
    const step = scale === 0 ? 2 * Math.PI : (384 * tolerance / (fourth * scale)) ** .25;
    const count = Math.max(1, Math.ceil(2 * Math.PI / step));
    if (!Number.isSafeInteger(count) || count > maxPieces) throw new RangeError('Cloud realization budget exhausted');
    const derivative = (t: number): Vec2 => {
        const r = 1 + .08 * Math.cos(10 * t), dr = -.8 * Math.sin(10 * t);
        return P(cloud.width * (dr * Math.cos(t) - r * Math.sin(t)) / (2 * 1.08),
            cloud.height * (dr * Math.sin(t) + r * Math.cos(t)) / (2 * cloud.yExtent));
    };
    yield { op: 'M', p: cloudPoint(cloud, 0) };
    for (let i = 0; i < count; i++) {
        const a = i * 2 * Math.PI / count, b = (i + 1) * 2 * Math.PI / count;
        const p0 = cloudPoint(cloud, a), p1 = cloudPoint(cloud, b), d0 = derivative(a), d1 = derivative(b), dt = (b - a) / 3;
        yield { op: 'C', c1: P(p0.x + d0.x * dt, p0.y + d0.y * dt), c2: P(p1.x - d1.x * dt, p1.y - d1.y * dt), p: p1 };
    }
    yield { op: 'Z' };
}
