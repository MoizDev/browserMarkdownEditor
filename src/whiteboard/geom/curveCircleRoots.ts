import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic, type Interval } from './numeric';
import { dyadicRatioInterval } from './dyadicRatio';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import type { Vec2 } from './path';
import { createPolynomialRootsJob } from './polynomialRootsJob';
import type { DyadicRootCell } from './polynomial';

export interface CircleRootBox { readonly x: Interval; readonly y: Interval; readonly exact?: Readonly<{ x: Dyadic; y: Dyadic }> }
export type CircleRootResult = Readonly<{ status: 'pending' }> | Readonly<{ status: 'done'; roots: readonly CircleRootBox[] }>
    | Readonly<{ status: 'uncertain'; reason: string }>;
interface Work { readonly curve: ExactCurve; readonly depth: number }
const ONE: Dyadic = Object.freeze({ n: 1n, e: 0 });
const PENDING: CircleRootResult = Object.freeze({ status: 'pending' });
const BINOMIAL: readonly (readonly bigint[])[] = [[1n], [1n, 1n], [1n, 2n, 1n], [1n, 3n, 3n, 1n], [1n, 4n, 6n, 4n, 1n],
    [1n, 5n, 10n, 10n, 5n, 1n], [1n, 6n, 15n, 20n, 15n, 6n, 1n]];
function sum(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function scale(value: Dyadic, factor: bigint): Dyadic { return { n: value.n * factor, e: value.e }; }
function sign(n: bigint): -1 | 0 | 1 { return n < 0n ? -1 : n > 0n ? 1 : 0; }
function variations(signs: readonly number[]): number {
    let previous = 0, changes = 0;
    for (const value of signs) { if (!value) continue; if (previous && previous !== value) changes++; previous = value; }
    return changes;
}
function pointBox(point: ExactCurve[number]): CircleRootBox {
    return { x: dyadicRatioInterval(point.x, ONE), y: dyadicRatioInterval(point.y, ONE), exact: { x: point.x, y: point.y } };
}
function box(curve: ExactCurve): CircleRootBox {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const point of curve) {
        const x = dyadicRatioInterval(point.x, ONE), y = dyadicRatioInterval(point.y, ONE);
        x0 = Math.min(x0, x.lo); x1 = Math.max(x1, x.hi); y0 = Math.min(y0, y.lo); y1 = Math.max(y1, y.hi);
    }
    return { x: { lo: x0, hi: x1 }, y: { lo: y0, hi: y1 } };
}
function same(a: Readonly<{ x: Dyadic; y: Dyadic }>, b: Readonly<{ x: Dyadic; y: Dyadic }>): boolean {
    return dyadicSubtract(a.x, b.x).n === 0n && dyadicSubtract(a.y, b.y).n === 0n;
}

/** Isolate all curve/circle boundary intersections by exact Bernstein signs.
 * A sign variation of one certifies exactly one open-interval root; unresolved
 * repeated roots or coincident arcs remain explicit uncertainty. */
export function createCurveCircleRootsJob(curve: ExactCurve, centre: Vec2, radius: number, options: {
    readonly width: number; readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number; readonly maxRoots?: number;
}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CircleRootResult; cancel(): void } {
    const maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 262144, maxWork = options.maxWork ?? 2000000, maxRoots = options.maxRoots ?? 16;
    if (![centre.x, centre.y, radius, options.width].every(Number.isFinite) || radius < 0 || options.width <= 0
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || !Number.isSafeInteger(maxRoots) || maxRoots < 1) throw new RangeError('Invalid curve circle root job');
    const cx = dyadic(centre.x), cy = dyadic(centre.y), r = dyadic(radius), rr = dyadicMultiply(r, r), stack: Work[] = [{ curve, depth: 0 }];
    const roots: CircleRootBox[] = []; let spent = 0, nodes = 1, cancelled = false, finished: CircleRootResult | undefined;
    let algebraic: ReturnType<typeof createPolynomialRootsJob> | undefined, algebraicCurve: ExactCurve | undefined;
    let cells: readonly DyadicRootCell[] = [], cellIndex = 0, cellCurve: ExactCurve | undefined, cellDepth = 0;
    const finish = (result: CircleRootResult): CircleRootResult => { finished = Object.freeze(result); return finished; };
    const append = (root: CircleRootBox) => {
        if (root.exact && roots.some(old => old.exact && same(old.exact, root.exact!))) return;
        if (roots.length >= maxRoots) throw new RangeError('Curve circle root limit exhausted');
        roots.push(Object.freeze(root));
    };
    const signs = (item: ExactCurve): readonly number[] => {
        const n = item.length - 1, shifted = item.map(p => ({ x: dyadicSubtract(p.x, cx), y: dyadicSubtract(p.y, cy) }));
        const out: number[] = [];
        for (let k = 0; k <= 2 * n; k++) {
            let coefficient: Dyadic = { n: 0n, e: 0 };
            for (let i = Math.max(0, k - n); i <= Math.min(n, k); i++) {
                const j = k - i, dot = sum(dyadicMultiply(shifted[i].x, shifted[j].x), dyadicMultiply(shifted[i].y, shifted[j].y));
                coefficient = sum(coefficient, scale(dot, BINOMIAL[n][i] * BINOMIAL[n][j]));
            }
            out.push(sign(dyadicSubtract(coefficient, scale(rr, BINOMIAL[2 * n][k])).n));
        }
        return out;
    };
    const polynomial = (item: ExactCurve): Dyadic[] => {
        const coordinate = (axis: 'x' | 'y', origin: Dyadic): Dyadic[] => {
            const p = item.map(point => point[axis]);
            if (p.length === 2) return [dyadicSubtract(p[0], origin), dyadicSubtract(p[1], p[0])];
            return [dyadicSubtract(p[0], origin), scale(dyadicSubtract(p[1], p[0]), 3n),
                scale(sum(dyadicSubtract(p[0], scale(p[1], 2n)), p[2]), 3n),
                sum(dyadicSubtract(scale(p[1], 3n), p[0]), dyadicSubtract(p[3], scale(p[2], 3n)))];
        };
        const x = coordinate('x', cx), y = coordinate('y', cy), result: Dyadic[] = Array.from({ length: x.length * 2 - 1 }, () => ({ n: 0n, e: 0 }));
        for (let i = 0; i < x.length; i++) for (let j = 0; j < x.length; j++)
            result[i + j] = sum(result[i + j], sum(dyadicMultiply(x[i], x[j]), dyadicMultiply(y[i], y[j])));
        result[0] = dyadicSubtract(result[0], rr); return result;
    };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid curve circle slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Curve circle job cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Curve circle work limit exhausted' });
                    if (algebraic) {
                        const result = algebraic.step({ deadline: budget.deadline, maxWork: 1 });
                        if (result.status === 'pending') continue;
                        algebraic.cancel(); algebraic = undefined;
                        if (result.status === 'uncertain') return finish(result);
                        cells = result.roots; cellIndex = 0; cellCurve = undefined; continue;
                    }
                    if (cellIndex < cells.length) {
                        const cell = cells[cellIndex];
                        if (!cellCurve) {
                            cellCurve = algebraicCurve!; cellDepth = 0;
                            if (cell.point && cell.index === (1n << BigInt(cell.depth))) {
                                append(pointBox(cellCurve[cellCurve.length - 1])); cellCurve = undefined; cellIndex++; continue;
                            }
                        }
                        if (cellDepth < cell.depth) {
                            const [left, right] = splitExactCurve(cellCurve), bit = (cell.index >> BigInt(cell.depth - cellDepth - 1)) & 1n;
                            cellCurve = bit ? right : left; cellDepth++; continue;
                        }
                        const root = cell.point ? pointBox(cellCurve[0]) : box(cellCurve);
                        if (!cell.point && Math.max(root.x.hi - root.x.lo, root.y.hi - root.y.lo) > options.width)
                            return finish({ status: 'uncertain', reason: 'Curve circle root enclosure exceeds its width' });
                        append(root); cellCurve = undefined; cellIndex++; continue;
                    }
                    if (cells.length) { cells = []; algebraicCurve = undefined; }
                    const item = stack.pop();
                    if (!item) return finish({ status: 'done', roots: Object.freeze(roots) });
                    const control = signs(item.curve);
                    if (control.every(value => value === 0)) return finish({ status: 'uncertain', reason: 'Curve is coincident with circle' });
                    if (!control[0]) append(pointBox(item.curve[0]));
                    if (!control[control.length - 1]) append(pointBox(item.curve[item.curve.length - 1]));
                    const count = variations(control); if (!count) continue;
                    const extent = box(item.curve);
                    if (![extent.x.lo, extent.x.hi, extent.y.lo, extent.y.hi].every(Number.isFinite)) return finish({ status: 'uncertain', reason: 'Curve circle root bounds overflow' });
                    if (Math.max(extent.x.hi - extent.x.lo, extent.y.hi - extent.y.lo) <= options.width) {
                        if (count === 1) append(extent);
                        else { algebraicCurve = item.curve; algebraic = createPolynomialRootsJob(polynomial(item.curve), { maxDepth, maxNodes, maxWork }); }
                        continue;
                    }
                    if (item.depth >= maxDepth) return finish({ status: 'uncertain', reason: 'Curve circle root cannot be isolated' });
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Curve circle node limit exhausted' });
                    const [left, right] = splitExactCurve(item.curve); nodes += 2;
                    stack.push({ curve: right, depth: item.depth + 1 }, { curve: left, depth: item.depth + 1 });
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; algebraic?.cancel(); algebraic = undefined; stack.length = 0; roots.length = 0; cells = []; cellCurve = algebraicCurve = undefined; },
    };
}
