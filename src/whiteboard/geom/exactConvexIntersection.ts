import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactIntersection, exactLineBetween, exactPoint, exactSide, sameExactPoint, type ExactLine, type ExactPoint } from './homogeneous';
import type { Vec2 } from './path';

export interface ExactConvexOperand { readonly points: readonly Vec2[]; readonly transform?: Affine }
export type ExactConvexIntersectionResult = Readonly<{ status: 'pending' | 'empty' | 'degenerate' }>
    | Readonly<{ status: 'bounded'; vertices: readonly ExactPoint[] }> | Readonly<{ status: 'uncertain'; reason: string }>;
interface Vertex { readonly point: ExactPoint; readonly incoming: ExactLine }
const PENDING: ExactConvexIntersectionResult = Object.freeze({ status: 'pending' });

/** Convex clipping retains homogeneous intersection vertices and original
 * support lines. No intermediate rational point is rounded to a float. */
export function createExactConvexIntersectionJob(operands: readonly ExactConvexOperand[], options: {
    readonly maxVertices?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ExactConvexIntersectionResult; cancel(): void } {
    const maxVertices = options.maxVertices ?? 4096, maxWork = options.maxWork ?? 1000000;
    if (!operands.length || operands.length > 65 || !Number.isSafeInteger(maxVertices) || maxVertices < 3 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid exact convex intersection');
    const calculate = function* (): Generator<void, ExactConvexIntersectionResult> {
        let vertices: Vertex[] = [], initialized = false;
        for (const operand of operands) {
            if (operand.points.length < 3 || operand.points.length > maxVertices || (operand.transform && !operand.transform.every(Number.isFinite)))
                throw new RangeError('Invalid convex operand');
            const points: ExactPoint[] = [];
            for (const point of operand.points) {
                const value = operand.transform ? exactAffinePoint(operand.transform, point) : exactPoint(point);
                if (!points.length || !sameExactPoint(points[points.length - 1], value)) points.push(value);
                yield;
            }
            if (points.length > 1 && sameExactPoint(points[0], points[points.length - 1])) points.pop();
            if (points.length < 3) return { status: 'degenerate' };
            const edges: ExactLine[] = [];
            for (let i = 0; i < points.length; i++) { edges.push(exactLineBetween(points[i], points[(i + 1) % points.length])); yield; }
            let winding = 0;
            for (const edge of edges) for (const point of points) {
                const side = exactSide(edge, point);
                if (side && winding && side !== winding) throw new RangeError('Convex operand is not convex');
                if (side) winding = side;
                yield;
            }
            if (!winding) return { status: 'degenerate' };
            if (winding < 0) {
                for (let lo = 0, hi = points.length - 1; lo < hi; lo++, hi--) { [points[lo], points[hi]] = [points[hi], points[lo]]; yield; }
                edges.length = 0;
                for (let i = 0; i < points.length; i++) { edges.push(exactLineBetween(points[i], points[(i + 1) % points.length])); yield; }
            }
            if (!initialized) {
                initialized = true;
                for (let i = 0; i < points.length; i++) { vertices.push({ point: points[i], incoming: edges[(i + edges.length - 1) % edges.length] }); yield; }
                continue;
            }
            for (const line of edges) {
                if (!vertices.length) return { status: 'empty' };
                const output: Vertex[] = [];
                const push = (value: Vertex) => { if (!output.length || !sameExactPoint(output[output.length - 1].point, value.point)) output.push(value); };
                let previous = vertices[vertices.length - 1], previousSide = exactSide(line, previous.point);
                for (const current of vertices) {
                    const currentSide = exactSide(line, current.point);
                    if ((previousSide < 0 && currentSide >= 0) || (previousSide >= 0 && currentSide < 0)) {
                        const intersection = exactIntersection(current.incoming, line);
                        if (!intersection) return { status: 'uncertain', reason: 'Convex supporting lines do not intersect' };
                        push({ point: intersection, incoming: previousSide < 0 ? line : current.incoming });
                    }
                    if (currentSide >= 0) push(current);
                    previous = current; previousSide = currentSide; yield;
                }
                if (output.length > 1 && sameExactPoint(output[0].point, output[output.length - 1].point)) {
                    output[0] = { point: output[0].point, incoming: output[output.length - 1].incoming }; output.pop();
                }
                if (output.length > maxVertices) return { status: 'uncertain', reason: 'Convex intersection vertex limit exhausted' };
                vertices = output;
            }
        }
        if (!vertices.length) return { status: 'empty' };
        if (vertices.length < 3) return { status: 'degenerate' };
        const line = exactLineBetween(vertices[0].point, vertices[1].point); let area = false;
        for (let i = 2; i < vertices.length; i++) { if (exactSide(line, vertices[i].point)) area = true; yield; }
        if (!area) return { status: 'degenerate' };
        const result: ExactPoint[] = [];
        for (const vertex of vertices) { result.push(vertex.point); yield; }
        return { status: 'bounded', vertices: Object.freeze(result) };
    };
    let iterator: Generator<void, ExactConvexIntersectionResult> | undefined, cancelled = false, spent = 0, finished: ExactConvexIntersectionResult | undefined;
    const finish = (result: ExactConvexIntersectionResult): ExactConvexIntersectionResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid convex intersection slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Convex intersection cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Convex intersection work limit exhausted' });
                    const next = iterator.next(); if (next.done) return finish(next.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Convex intersection cancelled' }); iterator = undefined; },
    };
}
