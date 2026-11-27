import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import { exactPoint, type ExactPoint } from './homogeneous';
import { exactSegmentsIntersect } from './exactSegments';
import { orient2d } from './predicates';
import type { Vec2 } from './path';

export type PolygonTriangulationResult = Readonly<{ status: 'pending' }> | Readonly<{ status: 'done'; triangles: readonly (readonly [Vec2, Vec2, Vec2])[] }>
    | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: PolygonTriangulationResult = Object.freeze({ status: 'pending' });
const same = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
const between = (a: Vec2, b: Vec2, p: Vec2) => p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
function add(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }

export function createPolygonTriangulationJob(input: readonly Vec2[], options: {
    readonly maxVertices?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): PolygonTriangulationResult; cancel(): void } {
    const maxVertices = options.maxVertices ?? 8192, maxWork = options.maxWork ?? 4000000;
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid polygon triangulation budget');
    const calculate = function* (): Generator<void, PolygonTriangulationResult> {
        if (input.length > maxVertices) return { status: 'uncertain', reason: 'Lasso vertex limit exhausted' };
        const points: Vec2[] = [];
        for (const point of input) {
            if (![point.x, point.y].every(Number.isFinite)) throw new RangeError('Invalid lasso vertex');
            if (!points.length || !same(points[points.length - 1], point)) points.push(Object.freeze({ x: point.x, y: point.y }));
            yield;
        }
        if (points.length > 1 && same(points[0], points[points.length - 1])) points.pop();
        if (points.length < 3) return { status: 'uncertain', reason: 'Lasso has no polygonal interior' };
        const n = points.length, prev = new Int32Array(n), next = new Int32Array(n), alive = new Uint8Array(n);
        for (let i = 0; i < n; i++) { prev[i] = (i + n - 1) % n; next[i] = (i + 1) % n; alive[i] = 1; yield; }
        let remaining = n, cursor = 0, unchanged = 0;
        while (remaining > 3 && unchanged < remaining) {
            const before = prev[cursor], after = next[cursor];
            if (!orient2d(points[before], points[cursor], points[after])) {
                if (!between(points[before], points[after], points[cursor]) || same(points[before], points[after]))
                    return { status: 'uncertain', reason: 'Lasso has a folded boundary' };
                next[before] = after; prev[after] = before; alive[cursor] = 0; remaining--; cursor = after; unchanged = 0;
            } else { cursor = after; unchanged++; }
            yield;
        }
        const vertices: number[] = []; let first = cursor;
        do { vertices.push(cursor); cursor = next[cursor]; yield; } while (cursor !== first);
        if (vertices.length < 3) return { status: 'uncertain', reason: 'Lasso has no polygonal interior' };
        const exact: ExactPoint[] = [];
        for (const index of vertices) { exact.push(exactPoint(points[index])); yield; }
        for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) {
            if (j !== i + 1 && !(i === 0 && j === vertices.length - 1)
                && exactSegmentsIntersect(exact[i], exact[(i + 1) % vertices.length], exact[j], exact[(j + 1) % vertices.length]))
                return { status: 'uncertain', reason: 'Lasso boundary is not simple' };
            yield;
        }
        let area: Dyadic = { n: 0n, e: 0 };
        for (let i = 0; i < vertices.length; i++) {
            const a = points[vertices[i]], b = points[vertices[(i + 1) % vertices.length]];
            area = add(area, dyadicSubtract(dyadicMultiply(dyadic(a.x), dyadic(b.y)), dyadicMultiply(dyadic(a.y), dyadic(b.x)))); yield;
        }
        const winding = area.n < 0n ? -1 : area.n > 0n ? 1 : 0;
        if (!winding) return { status: 'uncertain', reason: 'Lasso area is degenerate' };
        const triangles: [Vec2, Vec2, Vec2][] = []; cursor = first; let rejected = 0;
        while (remaining > 3) {
            const a = prev[cursor], c = next[cursor], turn = orient2d(points[a], points[cursor], points[c]);
            let ear = turn === winding;
            if (ear) {
                let other = next[c];
                while (other !== a) {
                    if (alive[other]) {
                        const p = points[other], ab = orient2d(points[a], points[cursor], p) * winding;
                        const bc = orient2d(points[cursor], points[c], p) * winding, ca = orient2d(points[c], points[a], p) * winding;
                        if (ab >= 0 && bc >= 0 && ca >= 0) { ear = false; break; }
                    }
                    other = next[other]; yield;
                }
            }
            if (ear) {
                triangles.push([points[a], points[cursor], points[c]]); next[a] = c; prev[c] = a; alive[cursor] = 0;
                remaining--; cursor = c; rejected = 0;
            } else {
                cursor = c; if (++rejected >= remaining) return { status: 'uncertain', reason: 'Lasso triangulation cannot certify an ear' };
            }
            yield;
        }
        first = cursor; const b = next[first], c = next[b];
        if (orient2d(points[first], points[b], points[c]) !== winding) return { status: 'uncertain', reason: 'Lasso final triangle is degenerate' };
        triangles.push([points[first], points[b], points[c]]);
        return { status: 'done', triangles: Object.freeze(triangles.map(triangle => Object.freeze(triangle))) };
    };
    let iterator: Generator<void, PolygonTriangulationResult> | undefined, spent = 0, cancelled = false, finished: PolygonTriangulationResult | undefined;
    const finish = (value: PolygonTriangulationResult): PolygonTriangulationResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid polygon triangulation slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Lasso triangulation cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Lasso triangulation work limit exhausted' });
                    const next = iterator.next(); if (next.done) return finish(next.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Lasso triangulation cancelled' }); iterator = undefined; },
    };
}
