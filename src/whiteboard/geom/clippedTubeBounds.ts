import type { Box } from './bounds';
import { createCircleClipBoundsJob } from './circleClipBounds';
import type { CircleClipResult } from './circleClipBounds';
import { add, dyadic, dyadicSubtract, interval, multiply, nextDown, nextUp, sqrtInterval, subtract } from './numeric';
import type { Dyadic, Interval } from './numeric';
import type { Cubic, Vec2 } from './path';

export type ClippedTubeResult =
    | { readonly status: 'bounded'; readonly bounds: Box; readonly errorWorld: number }
    | { readonly status: 'empty' }
    | { readonly status: 'uncertain'; readonly reason: string };
export type ClippedTubeStep = { readonly done: false } | { readonly done: true; readonly result: ClippedTubeResult };
export interface ClippedTubeLimits { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number }
export interface ClippedTubeBudget { readonly deadline: number; readonly maxWork: number }

type Coordinate = { readonly range: Interval; readonly exact: Dyadic; readonly value: number };
type Control = { readonly x: Coordinate; readonly y: Coordinate };
type Controls = readonly [Control, Control, Control, Control];
type WorkNode = { readonly controls: Controls; readonly radii: readonly [Interval, Interval]; readonly depth: number };
function coord(value: number): Coordinate { return { range: interval(value), exact: dyadic(value), value }; }
function midpoint(a: Coordinate, b: Coordinate): Coordinate {
    const sum = dyadicSubtract(a.exact, { n: -b.exact.n, e: b.exact.e });
    return { range: add(multiply(a.range, interval(0.5)), multiply(b.range, interval(0.5))),
        exact: { n: sum.n, e: sum.e - 1 }, value: a.value * 0.5 + b.value * 0.5 };
}
function mid(a: Control, b: Control): Control { return { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y) }; }
function split(p: Controls): { left: Controls; right: Controls; middle: Control } {
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
export function createClippedTubeBoundsJob(curve: Cubic, radius: number | readonly [number, number], clip: readonly Vec2[], tolerance: number,
    limits: ClippedTubeLimits = {}): { step(budget: ClippedTubeBudget): ClippedTubeStep } {
    const points = [curve.p0, curve.p1, curve.p2, curve.p3];
    const radii: readonly [number, number] = typeof radius === 'number' ? [radius, radius] : radius;
    if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) || radii.length !== 2 || radii.some(r => !Number.isFinite(r) || r < 0)
        || !Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('Invalid cubic tube or tolerance');
    const maxDepth = limits.maxDepth ?? 32, maxNodes = limits.maxNodes ?? 65536, maxWork = limits.maxWork ?? 10000000;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || clip.length > 256) throw new RangeError('Invalid cubic tube work limits');
    const polygon = clip.map(p => ({ ...p }));
    const controls = points.map(p => ({ x: coord(p.x), y: coord(p.y) })) as unknown as Controls;
    const stack: WorkNode[] = [{ controls, radii: [interval(radii[0]), interval(radii[1])], depth: 0 }];
    let nodes = 1, spent = 0, result: ClippedTubeResult | undefined = tolerance / 8 === 0
        ? uncertainty('Cubic tube tolerance is below the numeric budget') : undefined;
    let outer: Box | null = null;
    // Each entry bounds an actual inner extremum on the inside, not merely the
    // outward edge of the circle job's numerical enclosure.
    let innerMinX = Infinity, innerMinY = Infinity, innerMaxX = -Infinity, innerMaxY = -Infinity;
    type Pending = { readonly kind: 'outer' | 'inner'; readonly job: ReturnType<typeof createCircleClipBoundsJob> };
    let pending: Pending | undefined, node: WorkNode | undefined, parts: ReturnType<typeof split> | undefined;
    let currentOuter: Box | null = null, sample = 0;
    const finish = (value: ClippedTubeResult): ClippedTubeStep => { result = value; return { done: true, result: value }; };
    const startCircle = (kind: Pending['kind'], centre: Vec2, r: number) => {
        pending = { kind, job: createCircleClipBoundsJob({ centre, radius: r }, polygon, tolerance / 8) };
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
                const kind = pending.kind; pending = undefined;
                if (progress.result.status === 'uncertain') return finish(uncertainty(progress.result.reason));
                if (kind === 'outer') {
                    if (progress.result.status === 'empty') { node = undefined; parts = undefined; continue; }
                    currentOuter = progress.result.bounds; sample = 0;
                } else acceptInner(progress.result);
                continue;
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
                const p = sample === 0 ? node.controls[0] : sample === 1 ? parts!.middle : node.controls[3]; sample++;
                const actual = locate(p);
                const r = sample === 1 ? node.radii[0] : sample === 2
                    ? add(multiply(node.radii[0], interval(0.5)), multiply(node.radii[1], interval(0.5))) : node.radii[1];
                // Shrinking by centre uncertainty makes this disc a subset of
                // the real disc; a nonrepresentable radius-zero sample is skipped.
                const radius = Math.max(0, r.lo);
                if (actual.error > radius || (radius === 0 && actual.error !== 0)) continue;
                const innerRadius = actual.error === 0 ? radius : nextDown(radius - actual.error);
                if (innerRadius < 0 || !Number.isFinite(innerRadius)) continue;
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
export function clippedTubeBounds(curve: Cubic, radius: number | readonly [number, number], clip: readonly Vec2[], tolerance: number,
    limits?: ClippedTubeLimits): ClippedTubeResult {
    const job = createClippedTubeBoundsJob(curve, radius, clip, tolerance, limits);
    for (;;) { const step = job.step({ maxWork: 4096, deadline: Number.MAX_VALUE }); if (step.done) return step.result; }
}
