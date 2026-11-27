import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactPoint, type ExactPoint } from './homogeneous';
import { exactPointOnSegment } from './exactSegments';
import { createCubicRootCertificate, type ExactCurvePoint } from './cubicRootCertificate';
import type { PathOp, Vec2 } from './path';

export type CubicBoundaryResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface CubicBoundaryLimits { readonly maxCommands?: number; readonly maxNodes?: number; readonly maxWork?: number }
const PENDING: CubicBoundaryResult = Object.freeze({ status: 'pending' });

export function createCubicBoundaryJob(paths: readonly (readonly PathOp[])[], query: Vec2, localToSurface: Affine,
    limits: CubicBoundaryLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CubicBoundaryResult; cancel(): void } {
    const maxCommands = limits.maxCommands ?? 8192, maxNodes = limits.maxNodes ?? 131072, maxWork = limits.maxWork ?? 1000000;
    if (![query.x, query.y, ...localToSurface].every(Number.isFinite) || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid cubic boundary job');
    const q = exactPoint(query), mapped = (value: Vec2) => exactAffinePoint(localToSurface, value);
    let finished: CubicBoundaryResult | undefined, cancelled = false, spent = 0, nodes = 0, commands = 0, pathIndex = 0, commandIndex = 0, uncertain = false;
    let first: ExactPoint | undefined, previous: ExactPoint | undefined, active: ReturnType<typeof createCubicRootCertificate> | undefined;
    const finish = (value: CubicBoundaryResult): CubicBoundaryResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid cubic boundary slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Cubic boundary job cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Cubic boundary work limit exhausted' });
                    if (active) {
                        const value = active.step({ deadline: budget.deadline, maxWork: 1 });
                        if (value.status === 'pending') continue;
                        active.cancel(); active = undefined;
                        if (value.status === 'hit') return finish({ status: 'hit' });
                        if (value.status === 'uncertain') uncertain = true;
                        continue;
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
                        const point = (value: ExactPoint): ExactCurvePoint => ({ x: value.x, y: value.y });
                        active = createCubicRootCertificate([point(previous), point(mapped(op.c1)), point(mapped(op.c2)), point(end)], point(q));
                    } else if (exactPointOnSegment(q, previous, end)) return finish({ status: 'hit' });
                    previous = end;
                }
                return PENDING;
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                return finish({ status: 'uncertain', reason: error.message });
            }
        },
        cancel() { cancelled = true; active?.cancel(); active = undefined; },
    };
}
