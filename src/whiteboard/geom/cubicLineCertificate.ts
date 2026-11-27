import { dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import { createCubicRootCertificate, type ExactCurvePoint } from './cubicRootCertificate';
import { splitExactCurve } from './exactCurve';

export type CubicLineResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface CubicLineLimits { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number }
type Cubic = readonly [ExactCurvePoint, ExactCurvePoint, ExactCurvePoint, ExactCurvePoint];
type Work = Readonly<{ points: Cubic; depth: number }>;
const PENDING: CubicLineResult = Object.freeze({ status: 'pending' });
const ZERO: Dyadic = Object.freeze({ n: 0n, e: 0 });
function add(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function compare(a: Dyadic, b: Dyadic): -1 | 0 | 1 { const value = dyadicSubtract(a, b).n; return value < 0n ? -1 : value > 0n ? 1 : 0; }
function split(value: Work): readonly [Work, Work] {
    const [left, right] = splitExactCurve(value.points), depth = value.depth + 1;
    return [{ points: left as Cubic, depth }, { points: right as Cubic, depth }];
}

export function createCubicLineCertificate(points: Cubic, start: ExactCurvePoint, end: ExactCurvePoint,
    limits: CubicLineLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CubicLineResult; cancel(): void } {
    const maxDepth = limits.maxDepth ?? 64, maxNodes = limits.maxNodes ?? 131072, maxWork = limits.maxWork ?? 1000000;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid cubic line certificate budget');
    const dx = dyadicSubtract(end.x, start.x), dy = dyadicSubtract(end.y, start.y);
    const lengthSquared = add(dyadicMultiply(dx, dx), dyadicMultiply(dy, dy));
    const degenerate = lengthSquared.n === 0n;
    const project = (p: ExactCurvePoint) => {
        const x = dyadicSubtract(p.x, start.x), y = dyadicSubtract(p.y, start.y);
        return { cross: dyadicSubtract(dyadicMultiply(x, dy), dyadicMultiply(y, dx)),
            along: add(dyadicMultiply(x, dx), dyadicMultiply(y, dy)) };
    };
    let finished: CubicLineResult | undefined, cancelled = false, spent = 0, nodes = 1, uncertain = false;
    let phase: 'start' | 'end' | 'curves' = 'start', active: ReturnType<typeof createCubicRootCertificate> | undefined;
    let activeCurve: Work | undefined, activeContained = false;
    const stack: Work[] = [{ points, depth: 0 }];
    const finish = (result: CubicLineResult): CubicLineResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid cubic line slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Cubic line certificate cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Cubic line work limit exhausted' });
                    if (active) {
                        const result = active.step({ deadline: budget.deadline, maxWork: 1 });
                        if (result.status === 'pending') continue;
                        active.cancel(); active = undefined;
                        if (phase === 'start' || phase === 'end') {
                            if (result.status === 'hit') return finish({ status: 'hit' });
                            if (result.status === 'uncertain') uncertain = true;
                            if (phase === 'start' && !degenerate) { phase = 'end'; continue; }
                            if (degenerate) return finish(uncertain ? { status: 'uncertain', reason: 'Cubic point root cannot be certified' } : { status: 'miss' });
                            phase = 'curves'; continue;
                        }
                        const curve = activeCurve!; activeCurve = undefined;
                        if (result.status === 'uncertain') { uncertain = true; continue; }
                        if (result.status === 'miss') continue;
                        if (activeContained) return finish({ status: 'hit' });
                        if (curve.depth >= maxDepth) { uncertain = true; continue; }
                        if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Cubic line node limit exhausted' });
                        const [left, right] = split(curve); nodes += 2; stack.push(right, left); continue;
                    }
                    if (phase === 'start') { active = createCubicRootCertificate(points, start); continue; }
                    if (phase === 'end') { active = createCubicRootCertificate(points, end); continue; }
                    const curve = stack.pop();
                    if (!curve) return finish(uncertain ? { status: 'uncertain', reason: 'Cubic segment intersection cannot be certified' } : { status: 'miss' });
                    const values = curve.points.map(project);
                    if (values.every(value => compare(value.along, ZERO) < 0) || values.every(value => compare(value.along, lengthSquared) > 0)) continue;
                    if (values.every(value => compare(value.cross, ZERO) > 0) || values.every(value => compare(value.cross, ZERO) < 0)) continue;
                    activeContained = values.every(value => compare(value.along, ZERO) >= 0 && compare(value.along, lengthSquared) <= 0);
                    const asPoint = (value: typeof values[number]): ExactCurvePoint => ({ x: value.cross, y: ZERO });
                    activeCurve = curve;
                    active = createCubicRootCertificate(values.map(asPoint) as unknown as Cubic, { x: ZERO, y: ZERO });
                }
                return PENDING;
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                return finish({ status: 'uncertain', reason: error.message });
            }
        },
        cancel() { cancelled = true; active?.cancel(); active = undefined; stack.length = 0; },
    };
}
