import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactPointIntervals } from './homogeneous';
import { splitCertifiedCurve, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import { certifiedCurveBox, type CertifiedClipBox } from './clippedPointPathJob';
import type { PathOp } from './path';

export type ContourBoxClearResult = Readonly<{ status: 'pending' | 'clear' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: ContourBoxClearResult = Object.freeze({ status: 'pending' });

export function createContourBoxClearJob(path: readonly PathOp[], transform: Affine, box: CertifiedClipBox, options: {
    readonly maxCommands?: number; readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ContourBoxClearResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 8192, maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 262144, maxWork = options.maxWork ?? 2000000;
    if (![...transform, ...box].every(Number.isFinite) || box[0] > box[2] || box[1] > box[3]
        || !Number.isSafeInteger(maxCommands) || maxCommands < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128
        || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid contour box query');
    const mapped = (point: { readonly x: number; readonly y: number }): BoundsPoint => exactPointIntervals(exactAffinePoint(transform, point));
    let first: BoundsPoint | undefined, previous: BoundsPoint | undefined, command = 0, commands = 0, nodes = 0, spent = 0;
    let cancelled = false, finished: ContourBoxClearResult | undefined; const stack: CertifiedCurve[] = [];
    const finish = (result: ContourBoxClearResult): ContourBoxClearResult => { finished = Object.freeze(result); return finished; };
    const push = (points: CertifiedCurve['points']) => {
        if (++nodes > maxNodes) throw new RangeError('Contour box node limit exhausted'); stack.push({ points, depth: 0 });
    };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid contour box slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Contour box query cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Contour box work limit exhausted' });
                    const curve = stack.pop();
                    if (curve) {
                        const bounds = certifiedCurveBox(curve.points);
                        if (bounds[2] < box[0] || bounds[0] > box[2] || bounds[3] < box[1] || bounds[1] > box[3]) continue;
                        if (curve.depth >= maxDepth) return finish({ status: 'uncertain', reason: 'Contour may touch the sample box' });
                        if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Contour box node limit exhausted' });
                        const [left, right] = splitCertifiedCurve(curve); nodes += 2; stack.push(right, left); continue;
                    }
                    if (command >= path.length) {
                        if (previous && first) { push([previous, first]); previous = first = undefined; continue; }
                        return finish({ status: 'clear' });
                    }
                    if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Contour box command limit exhausted' });
                    const op = path[command++];
                    if (op.op === 'M') {
                        if (previous && first) { command--; push([previous, first]); previous = first = undefined; continue; }
                        first = previous = mapped(op.p); continue;
                    }
                    if (!first || !previous) throw new RangeError('Contour path must begin with a move');
                    const end = op.op === 'Z' ? first : mapped(op.p);
                    if (op.op === 'C') push([previous, mapped(op.c1), mapped(op.c2), end]); else push([previous, end]);
                    previous = end;
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
