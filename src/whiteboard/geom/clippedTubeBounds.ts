import type { Box } from './bounds';
import type { Affine } from '../../platform/types';
import { exactAffinePoint, affineRadiusScale } from './exactAffine';
import { dyadicRatioInterval } from './dyadicRatio';
import { createCircleClipBoundsJob } from './circleClipBounds';
import type { CircleClipResult } from './circleClipBounds';
import { exactLineThrough, exactPoint, exactSide } from './homogeneous';
import type { ExactLine, ExactPoint } from './homogeneous';
import { add, dyadic, dyadicSubtract, interval, multiply, nextDown, nextUp, sqrtInterval, subtract } from './numeric';
import type { Dyadic, Interval } from './numeric';
import type { Cubic, Vec2 } from './path';

export type ClippedTubeResult =
    | { readonly status: 'bounded'; readonly bounds: Box; readonly errorWorld: number }
    | { readonly status: 'empty' }
    | { readonly status: 'uncertain'; readonly reason: string };
export type ClippedTubeStep = { readonly done: false } | { readonly done: true; readonly result: ClippedTubeResult };
export interface ClippedTubeLimits { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number; readonly localToWorld?: Affine }
export type TubeCurve = Cubic | readonly [Vec2, Vec2];
export type ClippedTubeClip = readonly Vec2[] | { readonly inner: readonly Vec2[]; readonly outer: readonly Vec2[] };
export interface ClippedTubeBudget { readonly deadline: number; readonly maxWork: number }

type Coordinate = { readonly range: Interval; readonly exact: Dyadic; readonly value: number };
type Control = { readonly x: Coordinate; readonly y: Coordinate };
type Controls = readonly [Control, Control] | readonly [Control, Control, Control, Control];
type WorkNode = { readonly controls: Controls; readonly radii: readonly [Interval, Interval]; readonly depth: number };
function coord(value: number): Coordinate { return { range: interval(value), exact: dyadic(value), value }; }
function midpoint(a: Coordinate, b: Coordinate): Coordinate {
    const sum = dyadicSubtract(a.exact, { n: -b.exact.n, e: b.exact.e });
    return { range: add(multiply(a.range, interval(0.5)), multiply(b.range, interval(0.5))),
        exact: { n: sum.n, e: sum.e - 1 }, value: a.value * 0.5 + b.value * 0.5 };
}
function mid(a: Control, b: Control): Control { return { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y) }; }
function split(p: Controls): { left: Controls; right: Controls; middle: Control } {
    if (p.length === 2) { const middle = mid(p[0], p[1]); return { left: [p[0], middle], right: [middle, p[1]], middle }; }
    const a = mid(p[0], p[1]), b = mid(p[1], p[2]), c = mid(p[2], p[3]);
    const d = mid(a, b), e = mid(b, c), m = mid(d, e);
    return { left: [p[0], a, d, m], right: [m, e, c, p[3]], middle: m };
}
function equalExact(value: Coordinate): boolean {
    return Number.isFinite(value.value) && dyadicSubtract(dyadic(value.value), value.exact).n === 0n;
}
function squareUpper(value: number): number { return multiply(interval(value), interval(value)).hi; }
function distanceUpper(x: number, y: number): number {
    return sqrtInterval(add(interval(squareUpper(x)), interval(squareUpper(y)))).hi;
}
/** A float centre plus a certified radius containing the exact dyadic point. */
function locate(p: Control): { centre: Vec2; error: number } {
    const centre = { x: p.x.value, y: p.y.value };
    const dx = equalExact(p.x) ? 0 : Math.max(Math.abs(subtract(p.x.range, interval(centre.x)).lo), Math.abs(subtract(p.x.range, interval(centre.x)).hi));
    const dy = equalExact(p.y) ? 0 : Math.max(Math.abs(subtract(p.y.range, interval(centre.y)).lo), Math.abs(subtract(p.y.range, interval(centre.y)).hi));
    return { centre, error: dx === 0 && dy === 0 ? 0 : distanceUpper(dx, dy) };
}
function enclosure(controls: Controls, centre: Vec2): number {
    let radius = 0;
    for (const p of controls) {
        const x = subtract(p.x.range, interval(centre.x)), y = subtract(p.y.range, interval(centre.y));
        radius = Math.max(radius, distanceUpper(Math.max(Math.abs(x.lo), Math.abs(x.hi)), Math.max(Math.abs(y.lo), Math.abs(y.hi))));
    }
    return radius;
}
function union(a: Box | null, b: Box): Box {
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}
function uncertainty(reason: string): ClippedTubeResult { return { status: 'uncertain', reason }; }

/** A depth-first certified union of clipped outer balls and actual inner discs. */
export function createClippedTubeBoundsJob(curve: TubeCurve, radius: number | readonly [number, number], clip: ClippedTubeClip, tolerance: number,
    limits: ClippedTubeLimits = {}): { step(budget: ClippedTubeBudget): ClippedTubeStep } {
    const points = 'p0' in curve ? [curve.p0, curve.p1, curve.p2, curve.p3] : curve;
    const radii: readonly [number, number] = typeof radius === 'number' ? [radius, radius] : radius;
    if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) || radii.length !== 2 || radii.some(r => !Number.isFinite(r) || r < 0)
        || !Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('Invalid cubic tube or tolerance');
    const maxDepth = limits.maxDepth ?? 32, maxNodes = limits.maxNodes ?? 65536, maxWork = limits.maxWork ?? 10000000;
    const sourceOuter = 'outer' in clip ? clip.outer : clip, sourceInner = 'inner' in clip ? clip.inner : clip;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || sourceOuter.length > 1024 || sourceInner.length > 1024) throw new RangeError('Invalid cubic tube work limits');
    const outerPolygon = sourceOuter.map(p => ({ ...p }));
    const innerPolygon = sourceInner === sourceOuter ? outerPolygon : sourceInner.map(p => ({ ...p }));
    const matrix = limits.localToWorld;
    const controls = points.map(p => {
        if (!matrix) return { x: coord(p.x), y: coord(p.y) };
        const exact = exactAffinePoint(matrix, p);
        const coordinate = (n: Dyadic): Coordinate => {
            const range = dyadicRatioInterval(n, exact.w);
            return { exact: n, range, value: range.lo / 2 + range.hi / 2 };
        };
        return { x: coordinate(exact.x), y: coordinate(exact.y) };
    }) as unknown as Controls;
    const scale = matrix ? affineRadiusScale(matrix) : interval(1);
    const stack: WorkNode[] = [{ controls, radii: [multiply(interval(radii[0]), scale), multiply(interval(radii[1]), scale)], depth: 0 }];
    let nodes = 1, spent = 0, result: ClippedTubeResult | undefined = tolerance / 8 === 0
        ? uncertainty('Cubic tube tolerance is below the numeric budget') : outerPolygon.length === 0 && innerPolygon.length === 0
            ? { status: 'empty' } : undefined;
    let outer: Box | null = null;
    // Each entry bounds an actual inner extremum on the inside, not merely the
    // outward edge of the circle job's numerical enclosure.
    let innerMinX = Infinity, innerMinY = Infinity, innerMaxX = -Infinity, innerMaxY = -Infinity;
    type Pending = { readonly kind: 'outer' | 'inner' | 'validateOuter' | 'validateInner'; readonly job: ReturnType<typeof createCircleClipBoundsJob>;
        readonly centre: Vec2; readonly radius: number; readonly retried: boolean };
    let pending: Pending | undefined, node: WorkNode | undefined, parts: ReturnType<typeof split> | undefined;
    let currentOuter: Box | null = null, sample = 0;
    let phase: 'validateOuter' | 'validateInner' | 'outerLines' | 'innerLines' | 'outerWinding' | 'innerWinding' | 'subset' | 'ready' = 'validateOuter';
    const outerLines: ExactLine[] = [], innerLines: ExactLine[] = [];
    let index = 0, subIndex = 0, outerWinding = 0, innerWinding = 0;
    let witness: { point: ExactPoint; control: Control; edge: number } | undefined;
    const finish = (value: ClippedTubeResult): ClippedTubeStep => { result = value; return { done: true, result: value }; };
    const startCircle = (kind: Pending['kind'], centre: Vec2, r: number, retried = false) => {
        const polygon = kind === 'inner' || kind === 'validateInner' ? innerPolygon : outerPolygon;
        pending = { kind, centre, radius: r, retried, job: createCircleClipBoundsJob({ centre, radius: r }, polygon, tolerance / 8) };
    };
    const clipBox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of outerPolygon) { clipBox[0] = Math.min(clipBox[0], p.x); clipBox[1] = Math.min(clipBox[1], p.y);
        clipBox[2] = Math.max(clipBox[2], p.x); clipBox[3] = Math.max(clipBox[3], p.y); }
    const intersect = (a: Box, b: Box): Box | null => {
        const value: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
        return value[0] > value[2] || value[1] > value[3] ? null : value;
    };
    const controlBox = (value: WorkNode): Box | null => {
        let box: Box | null = null;
        const maximum = Math.max(value.radii[0].hi, value.radii[1].hi);
        for (let i = 0; i < value.controls.length; i++) {
            const p = value.controls[i], r = value.controls.length === 2 ? value.radii[i].hi : maximum;
            box = union(box, [subtract(p.x.range, interval(r)).lo, subtract(p.y.range, interval(r)).lo,
                add(p.x.range, interval(r)).hi, add(p.y.range, interval(r)).hi]);
        }
        return intersect(box!, clipBox);
    };
    const sampleControl = (): Control => sample === 1 ? node!.controls[0] : sample === 2 ? parts!.middle : node!.controls.at(-1)!;
    const centreWitness = () => {
        if (!innerPolygon.length) return;
        const control = sampleControl();
        witness = { point: { x: control.x.exact, y: control.y.exact, w: { n: 1n, e: 0 } }, control, edge: 0 };
    };
    const acceptInner = (value: CircleClipResult) => {
        if (value.status !== 'bounded') return;
        const [x0, y0, x1, y1] = value.bounds, e = value.errorWorld;
        innerMinX = Math.min(innerMinX, nextUp(x0 + e)); innerMinY = Math.min(innerMinY, nextUp(y0 + e));
        innerMaxX = Math.max(innerMaxX, nextDown(x1 - e)); innerMaxY = Math.max(innerMaxY, nextDown(y1 - e));
    };
    return { step(budget) {
        if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid tube step budget');
        if (result) return { done: true, result };
        let work = 0;
        while (work < budget.maxWork && performance.now() < budget.deadline) {
            if (++spent > maxWork) return finish(uncertainty('Cubic tube work allocation exhausted'));
            work++;
            if (pending) {
                const progress = pending.job.step(1);
                if (!progress.done) continue;
                const previous = pending, kind = previous.kind; pending = undefined;
                if (kind === 'validateOuter' || kind === 'validateInner') {
                    if (progress.result.status === 'uncertain') return finish(uncertainty(progress.result.reason));
                    phase = kind === 'validateOuter' && innerPolygon.length ? 'validateInner' : 'outerLines'; continue;
                }
                if (kind === 'outer') {
                    if (progress.result.status === 'empty') { node = undefined; parts = undefined; continue; }
                    // A tangent of an APPROXIMATING ball is not a tangent of the
                    // real curve. Keep a certified control-hull upper enclosure
                    // and refine; only the final witness gap authorizes bounds.
                    const axis = controlBox(node!);
                    currentOuter = axis && (progress.result.status === 'bounded' ? intersect(axis, progress.result.bounds) : axis);
                    if (!currentOuter) { node = undefined; parts = undefined; continue; }
                    sample = 0;
                } else {
                    if (progress.result.status === 'uncertain' && !previous.retried && previous.radius > 0) {
                        const smaller = Math.max(0, nextDown(previous.radius - tolerance / 64));
                        if (smaller < previous.radius) { startCircle('inner', previous.centre, smaller, true); continue; }
                    }
                    acceptInner(progress.result); centreWitness();
                }
                continue;
            }
            if (phase === 'validateOuter' || phase === 'validateInner') { startCircle(phase, { x: 0, y: 0 }, 0); continue; }
            if (phase === 'outerLines' || phase === 'innerLines') {
                const polygon = phase === 'outerLines' ? outerPolygon : innerPolygon, lines = phase === 'outerLines' ? outerLines : innerLines;
                if (index < polygon.length) { lines.push(exactLineThrough(polygon[index], polygon[(index + 1) % polygon.length])); index++; continue; }
                index = 2; phase = phase === 'outerLines' ? 'innerLines' : 'outerWinding';
                if (phase === 'innerLines') index = 0;
                continue;
            }
            if (phase === 'outerWinding' || phase === 'innerWinding') {
                const polygon = phase === 'outerWinding' ? outerPolygon : innerPolygon, lines = phase === 'outerWinding' ? outerLines : innerLines;
                if (polygon.length && index < polygon.length) {
                    const side = exactSide(lines[0], exactPoint(polygon[index++]));
                    if (side) { if (phase === 'outerWinding') outerWinding = side; else innerWinding = side; index = polygon.length; }
                    continue;
                }
                if (polygon.length && !(phase === 'outerWinding' ? outerWinding : innerWinding)) return finish(uncertainty('Clip envelope has no area'));
                if (phase === 'outerWinding') { phase = 'innerWinding'; index = 2; }
                else { phase = 'subset'; index = 0; subIndex = 0; }
                continue;
            }
            if (phase === 'subset') {
                if (index < innerPolygon.length && outerLines.length) {
                    if (exactSide(outerLines[subIndex], exactPoint(innerPolygon[index])) * outerWinding < 0) return finish(uncertainty('Inner clip is not contained in outer clip'));
                    if (++subIndex === outerLines.length) { subIndex = 0; index++; }
                    continue;
                }
                if (!outerLines.length) return finish(uncertainty('Outer clip is empty while inner clip is not'));
                phase = 'ready'; continue;
            }
            if (witness) {
                if (witness.edge < innerLines.length) {
                    if (exactSide(innerLines[witness.edge++], witness.point) * innerWinding < 0) witness = undefined;
                    continue;
                }
                const p = witness.control;
                innerMinX = Math.min(innerMinX, p.x.range.hi); innerMinY = Math.min(innerMinY, p.y.range.hi);
                innerMaxX = Math.max(innerMaxX, p.x.range.lo); innerMaxY = Math.max(innerMaxY, p.y.range.lo);
                witness = undefined; continue;
            }
            if (!node) {
                node = stack.pop();
                if (!node) {
                    if (!outer) return finish({ status: 'empty' });
                    const error = nextUp(Math.max(0, innerMinX - outer[0], innerMinY - outer[1], outer[2] - innerMaxX, outer[3] - innerMaxY));
                    if (!Number.isFinite(error) || error > tolerance) return finish(uncertainty('Cubic tube bounds did not meet the error budget'));
                    return finish({ status: 'bounded', bounds: outer, errorWorld: error });
                }
                parts = split(node.controls);
                const middle = locate(parts.middle), cover = enclosure(node.controls, middle.centre);
                const outerRadius = nextUp(Math.max(node.radii[0].hi, node.radii[1].hi) + cover);
                if (!Number.isFinite(middle.centre.x) || !Number.isFinite(middle.centre.y) || !Number.isFinite(outerRadius)) return finish(uncertainty('Cubic tube enclosure overflow'));
                startCircle('outer', middle.centre, outerRadius); continue;
            }
            if (sample < 3) {
                const p = sample === 0 ? node.controls[0] : sample === 1 ? parts!.middle : node.controls.at(-1)!; sample++;
                const actual = locate(p);
                const r = sample === 1 ? node.radii[0] : sample === 2
                    ? add(multiply(node.radii[0], interval(0.5)), multiply(node.radii[1], interval(0.5))) : node.radii[1];
                // Shrinking by centre uncertainty makes this disc a subset of
                // the real disc; a nonrepresentable radius-zero sample is skipped.
                const radius = Math.max(0, r.lo);
                const innerRadius = actual.error === 0 ? radius : nextDown(radius - actual.error);
                if (innerPolygon.length && (radius === 0 || actual.error > radius || innerRadius < 0 || !Number.isFinite(innerRadius))) {
                    witness = { point: { x: p.x.exact, y: p.y.exact, w: { n: 1n, e: 0 } }, control: p, edge: 0 }; continue;
                }
                if (!innerPolygon.length) continue;
                startCircle('inner', actual.centre, innerRadius); continue;
            }
            const box = currentOuter!;
            const gap = nextUp(Math.max(0, innerMinX - box[0], innerMinY - box[1], box[2] - innerMaxX, box[3] - innerMaxY));
            if (gap <= tolerance) outer = union(outer, box);
            else {
                if (node.depth >= maxDepth || nodes + 2 > maxNodes) return finish(uncertainty('Cubic tube subdivision limit reached'));
                const middle = add(multiply(node.radii[0], interval(0.5)), multiply(node.radii[1], interval(0.5)));
                nodes += 2; stack.push({ controls: parts!.right, radii: [middle, node.radii[1]], depth: node.depth + 1 },
                    { controls: parts!.left, radii: [node.radii[0], middle], depth: node.depth + 1 });
            }
            node = undefined; parts = undefined; currentOuter = null;
        }
        return { done: false };
    } };
}

/** Synchronous convenience; interactive callers must drive the resumable job. */
export function clippedTubeBounds(curve: TubeCurve, radius: number | readonly [number, number], clip: ClippedTubeClip, tolerance: number,
    limits?: ClippedTubeLimits): ClippedTubeResult {
    const job = createClippedTubeBoundsJob(curve, radius, clip, tolerance, limits);
    for (;;) { const step = job.step({ maxWork: 4096, deadline: Number.MAX_VALUE }); if (step.done) return step.result; }
}
