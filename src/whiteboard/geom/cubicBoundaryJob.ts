import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactLineBetween, exactSide, sameExactPoint, type ExactPoint } from './homogeneous';
import { dyadic, dyadicSubtract, type Dyadic } from './numeric';
import type { PathOp, Vec2 } from './path';

export type CubicBoundaryResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface CubicBoundaryLimits { readonly maxCommands?: number; readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number }
type Point = Readonly<{ x: Dyadic; y: Dyadic }>;
type Work = Readonly<{ points: readonly [Point, Point, Point, Point]; depth: number }>;
const PENDING: CubicBoundaryResult = Object.freeze({ status: 'pending' });
function compare(a: Dyadic, b: Dyadic): -1 | 0 | 1 {
    const value = dyadicSubtract(a, b).n; return value < 0n ? -1 : value > 0n ? 1 : 0;
}
function midpoint(a: Dyadic, b: Dyadic): Dyadic {
    const sum = dyadicSubtract(a, { n: -b.n, e: b.e }); return { n: sum.n, e: sum.e - 1 };
}
function middle(a: Point, b: Point): Point { return { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y) }; }
function equal(a: Point, b: Point): boolean { return compare(a.x, b.x) === 0 && compare(a.y, b.y) === 0; }
function split(value: Work): readonly [Work, Work] {
    const p = value.points, a = middle(p[0], p[1]), b = middle(p[1], p[2]), c = middle(p[2], p[3]);
    const d = middle(a, b), e = middle(b, c), m = middle(d, e), depth = value.depth + 1;
    return [{ points: [p[0], a, d, m], depth }, { points: [m, e, c, p[3]], depth }];
}
function hullContains(points: Work['points'], query: Point): boolean {
    let left = points[0].x, right = left, top = points[0].y, bottom = top;
    for (let i = 1; i < points.length; i++) {
        if (compare(points[i].x, left) < 0) left = points[i].x;
        if (compare(points[i].x, right) > 0) right = points[i].x;
        if (compare(points[i].y, top) < 0) top = points[i].y;
        if (compare(points[i].y, bottom) > 0) bottom = points[i].y;
    }
    return compare(query.x, left) >= 0 && compare(query.x, right) <= 0 && compare(query.y, top) >= 0 && compare(query.y, bottom) <= 0;
}
function homogeneous(point: Point): ExactPoint { return { ...point, w: { n: 1n, e: 0 } }; }
function lineContains(a: Point, b: Point, q: Point): boolean {
    const x = homogeneous(a), y = homogeneous(b), point = homogeneous(q);
    if (sameExactPoint(x, y)) return sameExactPoint(x, point);
    return exactSide(exactLineBetween(x, y), point) === 0
        && compare(q.x, a.x) * compare(q.x, b.x) <= 0 && compare(q.y, a.y) * compare(q.y, b.y) <= 0;
}

/** Exact dyadic subdivision proves points on lines and dyadic-parameter cubic
 * points. Other boundary roots remain uncertain rather than guessed. */
export function createCubicBoundaryJob(paths: readonly (readonly PathOp[])[], query: Vec2, localToSurface: Affine,
    limits: CubicBoundaryLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CubicBoundaryResult; cancel(): void } {
    const maxCommands = limits.maxCommands ?? 8192, maxDepth = limits.maxDepth ?? 64, maxNodes = limits.maxNodes ?? 131072, maxWork = limits.maxWork ?? 1000000;
    if (![query.x, query.y, ...localToSurface].every(Number.isFinite) || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid cubic boundary job');
    const q: Point = { x: dyadic(query.x), y: dyadic(query.y) };
    const mapped = (value: Vec2): Point => { const p = exactAffinePoint(localToSurface, value); return { x: p.x, y: p.y }; };
    let finished: CubicBoundaryResult | undefined, cancelled = false, spent = 0, nodes = 0, commands = 0, pathIndex = 0, commandIndex = 0, uncertain = false;
    let first: Point | undefined, previous: Point | undefined;
    const stack: Work[] = [];
    const finish = (value: CubicBoundaryResult): CubicBoundaryResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid cubic boundary slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Cubic boundary job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Cubic boundary work limit exhausted' });
                const curve = stack.pop();
                if (curve) {
                    if (!hullContains(curve.points, q)) continue;
                    if (equal(curve.points[0], q) || equal(curve.points[3], q)) return finish({ status: 'hit' });
                    if (curve.depth >= maxDepth) { uncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Cubic boundary node limit exhausted' });
                    const [left, right] = split(curve); nodes += 2; stack.push(right, left); continue;
                }
                if (pathIndex >= paths.length) return finish(uncertain ? { status: 'uncertain', reason: 'Cubic boundary root cannot be certified' } : { status: 'miss' });
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; first = previous = undefined; continue; }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Cubic boundary command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { first = previous = mapped(op.p); continue; }
                if (!first || !previous) throw new RangeError('Cubic boundary path must begin with M');
                const end = op.op === 'Z' ? first : mapped(op.p);
                if (op.op === 'C') {
                    if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Cubic boundary node limit exhausted' });
                    stack.push({ points: [previous, mapped(op.c1), mapped(op.c2), end], depth: 0 });
                } else if (lineContains(previous, end, q)) return finish({ status: 'hit' });
                previous = end;
            }
            return PENDING;
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
