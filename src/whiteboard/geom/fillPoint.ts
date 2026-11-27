import { dyadic, dyadicMultiply, dyadicSubtract } from './numeric';
import { exactAffinePoint } from './exactAffine';
import type { ExactPoint } from './homogeneous';
import type { Affine } from '../../platform/types';
import type { Dyadic } from './numeric';
import type { PathOp, Vec2 } from './path';

export interface FillPointLimits { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number; readonly maxCommands?: number; readonly localToWorld?: Affine;
    readonly exactPoint?: ExactPoint }
export type FillPointStep = { readonly status: 'pending' | 'inside' | 'outside' } | { readonly status: 'uncertain'; readonly reason: string };
type DPoint = { readonly x: Dyadic; readonly y: Dyadic };
type Curve = { readonly p: readonly [DPoint, DPoint, DPoint, DPoint]; readonly depth: number };
const MAX_BITS = 16384, MAX_EXPONENT = 32768;
function size(n: bigint): number { return n === 0n ? 0 : (n < 0n ? -n : n).toString(2).length; }
function valid(v: Dyadic): void {
    if (!Number.isSafeInteger(v.e) || Math.abs(v.e) > MAX_EXPONENT || (v.n < 0n ? -v.n : v.n) >> BigInt(MAX_BITS)) {
        throw new RangeError('Fill point exact arithmetic limit');
    }
}
function sub(a: Dyadic, b: Dyadic): Dyadic {
    const e = Math.min(a.e, b.e);
    if ((a.n !== 0n && size(a.n) + a.e - e > MAX_BITS) || (b.n !== 0n && size(b.n) + b.e - e > MAX_BITS)) throw new RangeError('Fill point shift limit');
    const result = dyadicSubtract(a, b); valid(result); return result;
}
function mul(a: Dyadic, b: Dyadic): Dyadic {
    if (Math.abs(a.e + b.e) > MAX_EXPONENT || (a.n !== 0n && b.n !== 0n && size(a.n) + size(b.n) - 1 > MAX_BITS)) throw new RangeError('Fill point product limit');
    const result = dyadicMultiply(a, b); valid(result); return result;
}
function midpoint(a: Dyadic, b: Dyadic): Dyadic {
    const sum = sub(a, { n: -b.n, e: b.e }), result = { n: sum.n, e: sum.e - 1 };
    valid(result); return result;
}
function middle(a: DPoint, b: DPoint): DPoint { return { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y) }; }
function isUnitDyadic(w: Dyadic): boolean {
    let n = w.n, e = w.e;
    if (n === 0n) return false;
    while ((n & 1n) === 0n) { n >>= 1n; e += 1; }
    return n === 1n && e === 0;
}
function signed(n: bigint): -1 | 0 | 1 { return n < 0n ? -1 : n > 0n ? 1 : 0; }
function spans(a: bigint, b: bigint): boolean { return (a <= 0n && b >= 0n) || (b <= 0n && a >= 0n); }

export function createFillPointJob(paths: readonly (readonly PathOp[])[], point: Vec2, fillRule: 'nonzero' | 'evenodd',
    limits: FillPointLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): FillPointStep } {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || (fillRule !== 'nonzero' && fillRule !== 'evenodd')) throw new RangeError('Invalid fill point or rule');
    const maxDepth = limits.maxDepth ?? 64, maxNodes = limits.maxNodes ?? 1000000,
        maxWork = limits.maxWork ?? 5000000, maxCommands = limits.maxCommands ?? 1000000;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || !Number.isSafeInteger(maxCommands) || maxCommands < 1) throw new RangeError('Invalid fill point limits');
    // Compare the VALUE, not the fields: a dyadic is not canonical (2^52 * 2^-52 is 1), and a marquee's exact corners
    // carry such weights. The raw test refused them, so the region query failed and a marquee selected nothing.
    if (limits.exactPoint && !isUnitDyadic(limits.exactPoint.w)) throw new RangeError('Fill point requires unit homogeneous weight');
    const origin = limits.exactPoint ? { x: limits.exactPoint.x, y: limits.exactPoint.y } : { x: dyadic(point.x), y: dyadic(point.y) };
    valid(origin.x); valid(origin.y);
    const translate = (p: Vec2): DPoint => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError('Invalid fill path coordinate');
        const mapped = limits.localToWorld ? exactAffinePoint(limits.localToWorld, p) : { x: dyadic(p.x), y: dyadic(p.y) };
        return { x: sub(mapped.x, origin.x), y: sub(mapped.y, origin.y) };
    };
    let winding = 0, pathIndex = 0, commandIndex = 0, commands = 0, nodes = 0, work = 0;
    let start: DPoint | undefined, current: DPoint | undefined, finished: FillPointStep | undefined;
    const stack: Curve[] = [];
    const line = (a: DPoint, b: DPoint): boolean => {
        const cross = sub(mul(a.x, b.y), mul(a.y, b.x)).n;
        if (cross === 0n && spans(a.x.n, b.x.n) && spans(a.y.n, b.y.n)) return false;
        const aboveA = a.y.n > 0n, aboveB = b.y.n > 0n;
        if (aboveA !== aboveB && signed(cross) === (aboveB ? 1 : -1)) winding += aboveB ? 1 : -1;
        return true;
    };
    const finish = (value: FillPointStep): FillPointStep => { finished = value; return value; };
    return { step(budget) {
        if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid fill point step budget');
        if (finished) return finished;
        try {
            for (let slice = 0; slice < budget.maxWork && performance.now() < budget.deadline; slice++) {
                if (++work > maxWork) return finish({ status: 'uncertain', reason: 'Fill point work limit exhausted' });
                const curve = stack.pop();
                if (curve) {
                    const p = curve.p;
                    if (p.every(v => v.x.n > 0n)) { winding += Number(p[3].y.n > 0n) - Number(p[0].y.n > 0n); continue; }
                    if (p.every(v => v.x.n < 0n) || p.every(v => v.y.n > 0n) || p.every(v => v.y.n < 0n)) continue;
                    if (curve.depth >= maxDepth || nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Fill boundary or subdivision limit' });
                    const a = middle(p[0], p[1]), b = middle(p[1], p[2]), c = middle(p[2], p[3]);
                    const d = middle(a, b), e = middle(b, c), m = middle(d, e), depth = curve.depth + 1;
                    nodes += 2; stack.push({ p: [m, e, c, p[3]], depth }, { p: [p[0], a, d, m], depth }); continue;
                }
                if (pathIndex >= paths.length) return finish({ status: (fillRule === 'nonzero' ? winding !== 0 : Math.abs(winding) % 2 === 1) ? 'inside' : 'outside' });
                const path = paths[pathIndex];
                if (commandIndex >= path.length) {
                    if (current && start && !line(current, start)) return finish({ status: 'uncertain', reason: 'Point lies on fill boundary' });
                    current = start = undefined; pathIndex++; commandIndex = 0; continue;
                }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Fill path command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') {
                    if (current && start && !line(current, start)) return finish({ status: 'uncertain', reason: 'Point lies on fill boundary' });
                    start = current = translate(op.p); continue;
                }
                if (!start || !current) throw new RangeError('Fill path must start with M');
                if (op.op === 'Z') {
                    if (!line(current, start)) return finish({ status: 'uncertain', reason: 'Point lies on fill boundary' });
                    current = start; continue;
                }
                const end = translate(op.p);
                if (op.op === 'L') {
                    if (!line(current, end)) return finish({ status: 'uncertain', reason: 'Point lies on fill boundary' });
                } else if (op.op === 'C') {
                    if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Fill curve limit exhausted' });
                    stack.push({ p: [current, translate(op.c1), translate(op.c2), end], depth: 0 });
                }
                current = end;
            }
            return { status: 'pending' };
        } catch (error) {
            if (error instanceof RangeError && error.message.startsWith('Fill point ')) return finish({ status: 'uncertain', reason: error.message });
            throw error;
        }
    } };
}
