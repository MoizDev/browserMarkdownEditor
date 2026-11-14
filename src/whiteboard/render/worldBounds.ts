import type { Affine, PathCommand, Rect, Rgba } from '../../platform/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { Box } from '../geom/bounds';
import { createConvexClipJob, type ConvexClipPolygon } from '../geom/convexClip';
import { createConvexPathEnvelopeJob } from '../geom/convexPathEnvelope';
import { createClippedTubeBoundsJob, type ClippedTubeClip, type TubeCurve } from '../geom/clippedTubeBounds';
import { createFillPointJob } from '../geom/fillPoint';
import type { PathOp, Vec2 } from '../geom/path';
import { nextDown, nextUp } from '../geom/numeric';
import { exactAffinePoint } from '../geom/exactAffine';
import { exactPoint, exactLineBetween, exactSide, exactPointIntervals, type ExactLine } from '../geom/homogeneous';
import { inkCoverageChunks, type PaintClip, type PaintItem, type PaintNodeSource } from './paintStream';

export class BoardBoundsUncertified extends Error {
    constructor(readonly reason: string) { super(`Board geometry bounds are not certified: ${reason}`); this.name = 'BoardBoundsUncertified'; }
}
export interface BoardPaintBoundsOptions {
    /** The caller's allocator from the shared application governor. */
    readonly memory: MemoryAllocator;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    readonly toleranceWorld?: number;
    readonly includeInvisible?: boolean;
}
export interface BoardPaintBounds { readonly bounds: Box | null; readonly errorWorld: number }
type ClipRegion = readonly ClippedTubeClip[];
interface ClipPlan { readonly inner: readonly ConvexClipPolygon[]; readonly outer: readonly ConvexClipPolygon[]; readonly planes: readonly ExactLine[] }
const flipLine = (line: ExactLine): ExactLine => ({ a: { n: -line.a.n, e: line.a.e }, b: { n: -line.b.n, e: line.b.e }, c: { n: -line.c.n, e: line.c.e } });
const union = (a: Box | null, b: Box): Box => a
    ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
const pointBox = (p: Vec2): Box => [p.x, p.y, p.x, p.y];
function rectangle(r: Rect): PathCommand[] {
    return [['M', r.x, r.y], ['L', r.x + r.width, r.y], ['L', r.x + r.width, r.y + r.height], ['L', r.x, r.y + r.height], ['Z']];
}
function pathOperation(command: PathCommand): PathOp {
    switch (command[0]) {
        case 'M': return { op: 'M', p: { x: command[1], y: command[2] } };
        case 'L': return { op: 'L', p: { x: command[1], y: command[2] } };
        case 'C': return { op: 'C', c1: { x: command[1], y: command[2] }, c2: { x: command[3], y: command[4] }, p: { x: command[5], y: command[6] } };
        case 'Z': return { op: 'Z' };
    }
}
function* curves(path: readonly PathOp[], fill: boolean): Generator<TubeCurve> {
    let start: Vec2 | undefined, last: Vec2 | undefined;
    for (const op of path) {
        if (op.op === 'M') {
            if (fill && start && last && (start.x !== last.x || start.y !== last.y)) yield [last, start];
            start = last = op.p;
        } else {
            if (!last || !start) throw new RangeError('Paint path lacks an initial move');
            if (op.op === 'Z') { yield [last, start]; last = start; }
            else if (op.op === 'L') { yield [last, op.p]; last = op.p; }
            else if (op.op === 'C') { yield { p0: last, p1: op.c1, p2: op.c2, p3: op.p }; last = op.p; }
        }
    }
    if (fill && start && last && (start.x !== last.x || start.y !== last.y)) yield [last, start];
}
/** Measures the canonical immutable paint producer, not Scene slots, native b,
 * an unclipped node box, or a temporary viewport raster. The source's lease is
 * the caller's responsibility and remains held through every cooperative await. */
export async function measureBoardPaintBounds(source: PaintNodeSource, options: BoardPaintBoundsOptions): Promise<BoardPaintBounds> {
    const tolerance = options.toleranceWorld ?? 0.01;
    if (!Number.isFinite(tolerance) || tolerance <= 0 || !Number.isSafeInteger(source.nodeCount) || source.nodeCount < 0) throw new RangeError('Invalid board paint bounds input');
    const cooperate = options.cooperate ?? (() => {
        const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
        return scheduler?.yield ? scheduler.yield() : new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    const current = () => { options.signal?.throwIfAborted(); if (!source.isCurrent()) throw new DOMException('Board paint source expired', 'AbortError'); };
    const pause = async () => { current(); await cooperate(); current(); };
    let sliceEnd = performance.now() + 4, rows = 0;
    const checkpoint = async () => { current(); if (++rows % 128 === 0 || performance.now() >= sliceEnd) { await pause(); sliceEnd = performance.now() + 4; } };
    const finishJob = async <T>(job: { step(budget: { deadline: number; maxWork: number }): { done: false } | { done: true; result: T } }): Promise<T> => {
        for (;;) { current(); const step = job.step({ deadline: performance.now() + 4, maxWork: 256 }); if (step.done) return step.result; await pause(); }
    };
    const allocations = new Set<ByteLease>();
    const reserve = (bytes: number) => {
        const lease = options.memory.reserve(bytes);
        if (!lease) throw new Error('Insufficient shared memory for board geometry bounds');
        allocations.add(lease); return lease;
    };
    const release = (lease: ByteLease) => { if (allocations.delete(lease)) options.memory.release(lease); };
    const paths = new Map<readonly PathCommand[], { path: readonly PathOp[]; lease: ByteLease }>();
    const readPath = async (commands: readonly PathCommand[]): Promise<readonly PathOp[]> => {
        const cached = paths.get(commands); if (cached) return cached.path;
        const lease = reserve(commands.length * 160 + 1024);
        const result: PathOp[] = [];
        for (const command of commands) { result.push(pathOperation(command)); await checkpoint(); }
        for (const prior of paths.values()) release(prior.lease);
        paths.clear(); paths.set(commands, { path: result, lease }); return result;
    };
    const clipCache = new Map<readonly PaintClip[], { value: ClipRegion | 'empty'; lease?: ByteLease }>();
    const clipEnvelope = async (clips: readonly PaintClip[]): Promise<ClipRegion | 'empty' | null> => {
        if (!clips.length) return null;
        const cached = clipCache.get(clips); if (cached) return cached.value;
        const innerPolygons: ConvexClipPolygon[] = [], outerPolygons: ConvexClipPolygon[] = [], temporary: ByteLease[] = [];
        let hasCurve = false;
        const differences: { polygon: ConvexClipPolygon; edges: readonly ExactLine[] }[][] = [];
        for (const clip of clips) {
            if (clip.fillRule === 'evenodd') {
                const contours: Vec2[][] = [];
                let contour: Vec2[] | undefined, open = false;
                for (const command of clip.d) {
                    if (command[0] === 'M') { if (open) throw new BoardBoundsUncertified('Open exclusion contour'); contour = []; contours.push(contour); open = true; }
                    if (command[0] === 'C') throw new BoardBoundsUncertified('Curved exclusion contour requires its own certified partition');
                    if (command[0] === 'Z') open = false;
                    else { if (!contour || !open) throw new BoardBoundsUncertified('Invalid exclusion contour'); contour.push({ x: command[1], y: command[2] }); }
                    await checkpoint();
                }
                if (open || contours.length !== 2) throw new BoardBoundsUncertified('Exclusion must have its actual two closed contours');
                const operands = [];
                for (const points of contours) {
                    if (points.length !== 4) throw new BoardBoundsUncertified('Exclusion is not a rectangular halo');
                    const world = points.map(point => exactAffinePoint(clip.localToWorld, point));
                    let edges = world.map((point, i) => exactLineBetween(point, world[(i + 1) % world.length]));
                    const winding = exactSide(edges[0], world[2]);
                    if (!winding) throw new BoardBoundsUncertified('Degenerate exclusion contour');
                    if (winding < 0) edges = edges.map(flipLine);
                    for (const edge of edges) for (const point of world) {
                        if (exactSide(edge, point) < 0) throw new BoardBoundsUncertified('Non-convex exclusion contour'); await checkpoint();
                    }
                    operands.push({ polygon: { points, localToWorld: clip.localToWorld }, edges });
                }
                differences.push(operands); continue;
            }
            const points: Vec2[] = [];
            let closed = false, curved = false, moved = false;
            for (const command of clip.d) {
                if (command[0] === 'M') { if (moved) throw new BoardBoundsUncertified(`Multiple clip contours ${clip.key}`); moved = true; }
                if (command[0] === 'Z') closed = true;
                else if (command[0] === 'C') curved = true;
                else points.push({ x: command[1], y: command[2] });
                await checkpoint();
            }
            if (!closed) throw new BoardBoundsUncertified(`Open clip ${clip.key}`);
            if (curved) {
                // The inner curve polygon is a genuine subset; the outer
                // control hull is a superset. Never turn a flattened ellipse's
                // midpoint error into an exact clipping authority.
                hasCurve = true; temporary.push(reserve(32768 * 1024));
                const envelope = await finishJob(createConvexPathEnvelopeJob(await readPath(clip.d), clip.localToWorld,
                    tolerance / 4, { maxLeaves: 4096, maxPoints: 32768 }));
                if (envelope.status === 'uncertain') throw new BoardBoundsUncertified(envelope.reason);
                innerPolygons.push(envelope.inner); outerPolygons.push(envelope.outer);
            } else {
                if (points.length < 3) throw new BoardBoundsUncertified(`Empty clip ${clip.key}`);
                const polygon = { points, localToWorld: clip.localToWorld };
                innerPolygons.push(polygon); outerPolygons.push(polygon);
            }
        }
        let plans: ClipPlan[] = [{ inner: innerPolygons, outer: outerPolygons, planes: [] }];
        for (const operands of differences) {
            const next: ClipPlan[] = [];
            // Even/odd with two convex contours is their SYMMETRIC difference,
            // not just subtraction: a halo can extend outside the outer box.
            for (const plan of plans) for (let side = 0; side < 2; side++) {
                const positive = operands[side], negative = operands[1 - side];
                for (let edge = 0; edge < negative.edges.length; edge++) {
                    next.push({ inner: [...plan.inner, positive.polygon], outer: [...plan.outer, positive.polygon],
                        planes: [...plan.planes, ...negative.edges.slice(0, edge), flipLine(negative.edges[edge])] });
                    if (next.length > 256) throw new BoardBoundsUncertified('Exclusion partition exceeds its work budget');
                    await checkpoint();
                }
            }
            plans = next;
        }
        const count = (polygons: readonly ConvexClipPolygon[]) => polygons.reduce((n, polygon) => n + ('points' in polygon ? polygon.points.length : polygon.length), 0);
        const lease = reserve(plans.reduce((n, plan) => n + count(plan.outer) + (hasCurve ? count(plan.inner) : 0) + plan.planes.length, 0) * 8192 + 1024 * 1024);
        const pieces: ClippedTubeClip[] = [];
        for (const plan of plans) {
            const result = await finishJob(createConvexClipJob(plan.outer, tolerance / 32, plan.planes));
            if (result.status === 'uncertain') throw new BoardBoundsUncertified(result.reason);
            if (result.status === 'empty') continue;
            if (!hasCurve) pieces.push({ inner: result.inner, outer: result.outer });
            else {
                const inside = await finishJob(createConvexClipJob(plan.inner, tolerance / 32, plan.planes));
                if (inside.status === 'uncertain') throw new BoardBoundsUncertified(inside.reason);
                pieces.push({ inner: inside.status === 'empty' ? [] : inside.inner, outer: result.outer });
            }
            await checkpoint();
        }
        const value: ClipRegion | 'empty' = pieces.length ? pieces : 'empty';
        for (const allocation of temporary) release(allocation);
        for (const prior of clipCache.values()) if (prior.lease) release(prior.lease);
        clipCache.clear();
        if (value === 'empty') { release(lease); clipCache.set(clips, { value }); }
        else clipCache.set(clips, { value, lease });
        return value;
    };
    const clipPoints = (clip: ClippedTubeClip, side: 'inner' | 'outer'): readonly Vec2[] => 'inner' in clip ? clip[side] : clip;
    const visible = (color: Rgba | undefined) => !!color && (options.includeInvisible || color[3] > 0);
    let bounds: Box | null = null, errorWorld = 0;
    const accept = (value: BoardPaintBounds) => { if (value.bounds) bounds = union(bounds, value.bounds); errorWorld = Math.max(errorWorld, value.errorWorld); };
    const tube = async (curve: TubeCurve, radius: number | readonly [number, number], matrix: Affine, clip: ClippedTubeClip): Promise<BoardPaintBounds> => {
        const lease = reserve((clipPoints(clip, 'inner').length + clipPoints(clip, 'outer').length) * 4096 + 512 * 1024);
        try {
            const result = await finishJob(createClippedTubeBoundsJob(curve, radius, clip, tolerance / 2, { localToWorld: matrix }));
            if (result.status === 'uncertain') throw new BoardBoundsUncertified(result.reason);
            return result.status === 'empty' ? { bounds: null, errorWorld: 0 } : { bounds: result.bounds, errorWorld: result.errorWorld };
        } finally { release(lease); }
    };
    const unboundedClip = async (commands: readonly PathOp[], matrix: Affine, pad: number): Promise<ClippedTubeClip> => {
        let box: Box | null = null;
        for (const op of commands) {
            if (op.op !== 'Z') for (const p of op.op === 'C' ? [op.c1, op.c2, op.p] : [op.p]) {
                const exact = exactPointIntervals(exactAffinePoint(matrix, p));
                box = union(box, [exact.x.lo, exact.y.lo, exact.x.hi, exact.y.hi]); await checkpoint();
            }
        }
        if (!box) throw new BoardBoundsUncertified('Paint path contains no coordinates');
        const margin = Math.max(1, pad * (Math.abs(matrix[0]) + Math.abs(matrix[1]) + Math.abs(matrix[2]) + Math.abs(matrix[3])));
        const x0 = nextDown(box[0] - margin), y0 = nextDown(box[1] - margin), x1 = nextUp(box[2] + margin), y1 = nextUp(box[3] + margin);
        if (![x0, y0, x1, y1].every(Number.isFinite)) throw new BoardBoundsUncertified('Paint control enclosure overflow');
        return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    };
    const fillPoint = async (path: readonly PathOp[], matrix: Affine, point: Vec2, rule: 'nonzero' | 'evenodd') => {
        const lease = reserve(256 * 1024);
        try {
            const job = createFillPointJob([path], point, rule, { localToWorld: matrix });
            for (;;) { current(); const result = job.step({ deadline: performance.now() + 4, maxWork: 256 }); if (result.status !== 'pending') return result.status; await pause(); }
        } finally { release(lease); }
    };
    const fill = async (path: readonly PathOp[], matrix: Affine, clip: ClippedTubeClip, rule: 'nonzero' | 'evenodd', rectangleSource = false): Promise<BoardPaintBounds> => {
        // These paths are constructed here from positive-size image/text rects.
        // Their closed boundary is genuine filled area, not a heuristic winding
        // answer at a curve boundary (which remains uncertain in fillPoint).
        const corners = rectangleSource ? path.flatMap(op => op.op === 'M' || op.op === 'L' ? [exactAffinePoint(matrix, op.p)] : []) : [];
        const edges = corners.map((point, i) => exactLineBetween(point, corners[(i + 1) % corners.length]));
        const winding = corners.length >= 3 ? exactSide(edges[0], corners[2]) : 0;
        if (rectangleSource && !winding) return { bounds: null, errorWorld: 0 };
        const classify = async (point: Vec2) => {
            if (!rectangleSource) return fillPoint(path, matrix, point, rule);
            const exact = exactPoint(point);
            return edges.every(edge => exactSide(edge, exact) * winding >= 0) ? 'inside' : 'outside';
        };
        let upper: Box | null = null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const witness = (box: Box, error: number) => { minX = Math.min(minX, nextUp(box[0] + error)); minY = Math.min(minY, nextUp(box[1] + error));
            maxX = Math.max(maxX, nextDown(box[2] - error)); maxY = Math.max(maxY, nextDown(box[3] - error)); };
        for (const point of clipPoints(clip, 'inner')) { if (await classify(point) === 'inside') witness(pointBox(point), 0); await checkpoint(); }
        let entireClip: Box | null = null;
        for (const point of clipPoints(clip, 'outer')) { entireClip = union(entireClip, pointBox(point)); await checkpoint(); }
        if (entireClip) {
            const gap = nextUp(Math.max(0, minX - entireClip[0], minY - entireClip[1], entireClip[2] - maxX, entireClip[3] - maxY));
            if (Number.isFinite(gap) && gap <= tolerance) return { bounds: entireClip, errorWorld: gap };
        }
        for (const curve of curves(path, true)) {
            const value = await tube(curve, 0, matrix, clip);
            if (value.bounds) { upper = union(upper, value.bounds); witness(value.bounds, value.errorWorld); }
            await checkpoint();
        }
        // Boundary curves alone miss a filled shape that completely contains the
        // clip. Inner vertices are real witnesses; ambiguous OUTER vertices only
        // enlarge the enclosure and can never authorize a false inner extremum.
        for (const point of clipPoints(clip, 'outer')) { if (await classify(point) !== 'outside') upper = union(upper, pointBox(point)); await checkpoint(); }
        if (!upper) return { bounds: null, errorWorld: 0 };
        const error = nextUp(Math.max(0, minX - upper[0], minY - upper[1], upper[2] - maxX, upper[3] - maxY));
        if (!Number.isFinite(error) || error > tolerance) throw new BoardBoundsUncertified('Filled path and frame enclosure did not converge');
        return { bounds: upper, errorWorld: error };
    };
    const measureItemInClip = async (item: PaintItem, envelope: ClippedTubeClip | null) => {
        if (item.kind === 'ink') {
            if (!visible(item.material.color)) return;
            for (const coverage of inkCoverageChunks(item.coverage)) {
                const base = coverage.boundsLocal;
                const clip = envelope ?? await unboundedClip(await readPath(rectangle({ x: base.x, y: base.y, width: base.w, height: base.h })), item.localToWorld, 1);
                for (let i = 0; i < coverage.segments.length; i += 6) {
                    const s = coverage.segments;
                    accept(await tube([{ x: s[i], y: s[i + 1] }, { x: s[i + 3], y: s[i + 4] }], [s[i + 2], s[i + 5]], item.localToWorld, clip)); await checkpoint();
                }
                for (let i = 0; i < coverage.discs.length; i += 3) {
                    const d = coverage.discs, p = { x: d[i], y: d[i + 1] };
                    accept(await tube([p, p], d[i + 2], item.localToWorld, clip)); await checkpoint();
                }
            }
            return;
        }
        if (item.kind === 'image' || item.kind === 'text') {
            if (item.kind === 'image' && !options.includeInvisible && item.opacity <= 0) return;
            if (item.kind === 'text' && !options.includeInvisible) {
                let painted = false;
                for (const colors of [item.material.glyphs, item.material.backgrounds, item.material.decorations]) {
                    for (const color of colors) { if (color[3] > 0) { painted = true; break; } await checkpoint(); }
                    if (painted) break;
                }
                if (!painted) return;
            }
            const rect = item.kind === 'image' ? item.rect : item.paint.ink;
            if (rect.width <= 0 || rect.height <= 0) return;
            const path = await readPath(rectangle(rect));
            const clip = envelope ?? await unboundedClip(path, item.localToWorld, 0);
            accept(await fill(path, item.localToWorld, clip, 'nonzero', true)); return;
        }
        const path = await readPath(item.d), stroke = item.material.stroke;
        const clip = envelope ?? await unboundedClip(path, item.localToWorld, stroke?.width ?? 0);
        if (visible(item.material.fill)) accept(await fill(path, item.localToWorld, clip, item.fillRule));
        if (stroke && stroke.width > 0 && visible(stroke.color)) {
            if (stroke.cap !== 'round' || stroke.join !== 'round') throw new BoardBoundsUncertified('Non-round path stroke requires its actual join/cap boundary');
            for (const curve of curves(path, false)) { accept(await tube(curve, stroke.width / 2, item.localToWorld, clip)); await checkpoint(); }
        }
    };
    const measureItem = async (item: PaintItem) => {
        const region = await clipEnvelope(item.clips);
        if (region === 'empty') return;
        if (region === null) await measureItemInClip(item, null);
        else for (const piece of region) { await measureItemInClip(item, piece); await checkpoint(); }
    };
    try {
        current();
        for (let index = 0; index < source.nodeCount; index++) {
            const node = source.readNode(index);
            for (const item of node.underlay ?? []) { await measureItem(item); await checkpoint(); }
            for (const item of node.content) { await measureItem(item); await checkpoint(); }
        }
        current(); return { bounds, errorWorld };
    } finally { for (const lease of allocations) options.memory.release(lease); allocations.clear(); paths.clear(); clipCache.clear(); }
}
