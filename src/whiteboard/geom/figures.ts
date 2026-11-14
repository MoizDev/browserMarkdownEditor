import type { Affine, Rect } from '../../platform/types';
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

export interface FigureCreationModifiers { readonly shift: boolean; readonly alt: boolean }

export function figureClickBox(shape: FigureShape, at: Vec2): Rect {
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new RangeError('Invalid figure origin');
    const width = shape === 'cloud' ? 300 : 200;
    const height = shape === 'cloud' ? 180 : shape === 'star' ? 190 : 200;
    return { x: at.x - width / 2, y: at.y - height / 2, width, height };
}

/** The one-world-unit seed fixes the centre of Alt-created figures across all camera zooms. */
export function figureDragBox(shape: FigureShape, down: Vec2, pointer: Vec2, modifiers: FigureCreationModifiers): Rect {
    if (![down.x, down.y, pointer.x, pointer.y].every(Number.isFinite)) throw new RangeError('Invalid figure gesture');
    const dx = pointer.x - down.x, dy = pointer.y - down.y;
    const cx = down.x + .5, cy = down.y + .5;
    let w = modifiers.alt ? 2 * Math.abs(pointer.x - cx) : Math.abs(dx);
    let h = modifiers.alt ? 2 * Math.abs(pointer.y - cy) : Math.abs(dy);
    w = Math.max(1, w); h = Math.max(1, h);
    if (modifiers.shift) w = h = Math.max(w, h);
    const x = modifiers.alt ? cx - w / 2 : dx < 0 ? down.x - w : down.x;
    const y = modifiers.alt ? cy - h / 2 : dy < 0 ? down.y - h : down.y;
    const result = fitFigureCreation(shape, { x, y, width: w, height: h });
    if (!modifiers.shift || !CREATION_FIT[shape]) return result;
    const side = Math.max(result.width, result.height);
    return {
        x: modifiers.alt ? cx - side / 2 : dx < 0 ? down.x - side : down.x,
        y: modifiers.alt ? cy - side / 2 : dy < 0 ? down.y - side : down.y,
        width: side, height: side,
    };
}

export function figureSemanticBounds(shape: FigureShape, width: number, height: number,
    flipX: boolean, flipY: boolean): Rect {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) throw new RangeError('Invalid figure box');
    const fit = CREATION_FIT[shape];
    const left = fit?.xInset ?? 0, top = fit?.yInset ?? 0, xScale = fit?.xScale ?? 1, yScale = fit?.yScale ?? 1;
    return { x: width * (flipX ? 1 - left - xScale : left), y: height * (flipY ? 1 - top - yScale : top),
        width: width * xScale, height: height * yScale };
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

export type FigureContour =
    | Readonly<{ kind: 'path'; ops: readonly PathOp[] }>
    | Readonly<{ kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }>
    | Readonly<{ kind: 'stadium'; width: number; height: number; radius: number }>
    | Readonly<{ kind: 'cloud'; shape: Extract<CurvedFigure, { kind: 'cloud' }>; transform: Affine }>;
export interface FigureOutline {
    readonly primary: FigureContour;
    readonly marks: readonly (readonly PathOp[])[];
}

/** One semantic outline shared by paint, selection, attachments and export. */
export function figureOutline(shape: FigureShape, width: number, height: number,
    flipX: boolean, flipY: boolean): FigureOutline {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) throw new RangeError('Invalid figure box');
    const paths = polygonFigure(shape);
    if (paths) return {
        primary: { kind: 'path', ops: placeFigurePath(paths[0], width, height, flipX, flipY, shape) },
        marks: paths.slice(1).map(path => placeFigurePath(path, width, height, flipX, flipY, shape)),
    };
    if (shape === 'heart') return {
        primary: { kind: 'path', ops: placeFigurePath(heart(1, 1), width, height, flipX, flipY, shape) }, marks: [],
    };
    if (shape === 'cloud') {
        const profile = CREATION_FIT.cloud!;
        const sx = width * profile.xScale * (flipX ? -1 : 1), sy = height * profile.yScale * (flipY ? -1 : 1);
        const tx = width * (flipX ? 1 - profile.xInset : profile.xInset);
        const ty = height * (flipY ? 1 - profile.yInset : profile.yInset);
        return { primary: { kind: 'cloud', shape: { kind: 'cloud', width: 1, height: 1, yExtent: CLOUD_Y_EXTENT },
            transform: [sx, 0, 0, sy, tx, ty] }, marks: [] };
    }
    if (shape === 'ellipse') return { primary: { kind: 'ellipse', cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2 }, marks: [] };
    return { primary: { kind: 'stadium', width, height, radius: Math.min(width, height) / 2 }, marks: [] };
}

// Ellipse and capsule arcs remain analytic in FigureContour; this emits bounded paint paths.
export function* ellipseArcPath(cx: number, cy: number, rx: number, ry: number, start: number,
    sweep: number, tolerance: number, maxPieces: number, move = true): Generator<PathOp> {
    if (![cx, cy, rx, ry, start, sweep, tolerance].every(Number.isFinite) || rx < 0 || ry < 0
        || tolerance <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid ellipse realization');
    const radius = Math.SQRT2 * Math.max(rx, ry);
    const step = radius === 0 ? Math.max(1, Math.abs(sweep)) : (384 * tolerance / radius) ** .25;
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / step));
    if (!Number.isSafeInteger(count) || count > maxPieces) throw new RangeError('Ellipse realization budget exhausted');
    const point = (t: number): Vec2 => P(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    const derivative = (t: number): Vec2 => P(-rx * Math.sin(t), ry * Math.cos(t));
    if (move) yield { op: 'M', p: point(start) };
    for (let i = 0; i < count; i++) {
        const a = start + sweep * i / count, b = start + sweep * (i + 1) / count;
        const p0 = point(a), p1 = point(b), d0 = derivative(a), d1 = derivative(b), dt = (b - a) / 3;
        yield { op: 'C', c1: P(p0.x + d0.x * dt, p0.y + d0.y * dt),
            c2: P(p1.x - d1.x * dt, p1.y - d1.y * dt), p: p1 };
    }
}

export function* stadiumPath(stadium: Extract<FigureContour, { kind: 'stadium' }>, tolerance: number,
    maxPieces: number): Generator<PathOp> {
    const { width: w, height: h, radius: r } = stadium;
    if (w >= h) {
        yield* ellipseArcPath(w - r, r, r, r, -Math.PI / 2, Math.PI, tolerance, maxPieces);
        yield { op: 'L', p: P(r, h) };
        yield* ellipseArcPath(r, r, r, r, Math.PI / 2, Math.PI, tolerance, maxPieces, false);
    } else {
        yield* ellipseArcPath(r, h - r, r, r, 0, Math.PI, tolerance, maxPieces);
        yield { op: 'L', p: P(0, r) };
        yield* ellipseArcPath(r, r, r, r, Math.PI, Math.PI, tolerance, maxPieces, false);
    }
    yield { op: 'Z' };
}

export function* realiseFigureContour(contour: FigureContour, tolerance: number, maxPieces: number): Generator<PathOp> {
    switch (contour.kind) {
        case 'path': yield* contour.ops; return;
        case 'ellipse':
            yield* ellipseArcPath(contour.cx, contour.cy, contour.rx, contour.ry, 0, 2 * Math.PI, tolerance, maxPieces);
            yield { op: 'Z' }; return;
        case 'stadium': yield* stadiumPath(contour, tolerance, maxPieces); return;
        case 'cloud': {
            const [a, b, c, d, e, f] = contour.transform;
            const scale = Math.hypot(a, b, c, d);
            const transform = (p: Vec2): Vec2 => P(a * p.x + c * p.y + e, b * p.x + d * p.y + f);
            for (const op of cloudPath(contour.shape, scale === 0 ? tolerance : tolerance / scale, maxPieces)) {
                if (op.op === 'C') yield { op: 'C', c1: transform(op.c1), c2: transform(op.c2), p: transform(op.p) };
                else if (op.op === 'Z') yield op;
                else yield { op: op.op, p: transform(op.p) };
            }
        }
    }
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
    const scale = Math.SQRT2 * Math.max(cloud.width / (2 * 1.08), cloud.height / (2 * cloud.yExtent));
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
