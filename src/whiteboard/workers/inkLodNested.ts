import type { WorkerContext } from '../../platform/workers';
import { add, divide, interval, multiply, nextDown, nextUp, subtract } from '../geom/numeric';
import type { InkCoverage } from '../ink/outline';
import type { InkCoverageRequest } from './geometryProtocol';

const upAdd = (a: number, b: number) => a === 0 && b === 0 ? 0 : nextUp(a + b);
const upMul = (a: number, b: number) => a === 0 || b === 0 ? 0 : nextUp(a * b);
const upperDiff = (a: number, b: number) => a === b ? 0 : nextUp(Math.abs(a - b));
const perimeter = (x0: number, y0: number, x1: number, y1: number, r: number) =>
    upMul(2, upAdd(upAdd(upperDiff(x0, x1), upperDiff(y0, y1)), upMul(4, r)));

function distanceUpper(x: number, y: number, ax: number, ay: number, bx: number, by: number, axis: 0 | 1): number {
    const a = axis ? ay : ax, b = axis ? by : bx, p = axis ? y : x;
    const t = divide(subtract(interval(p), interval(a)), subtract(interval(b), interval(a)));
    const clamped = { lo: Math.max(0, t.lo), hi: Math.min(1, t.hi) };
    if (clamped.lo > clamped.hi) return Infinity;
    const project = (start: number, end: number) => add(interval(start), multiply(clamped, subtract(interval(end), interval(start))));
    const px = project(ax, bx), py = project(ay, by);
    return upAdd(Math.max(upperDiff(x, px.lo), upperDiff(x, px.hi)), Math.max(upperDiff(y, py.lo), upperDiff(y, py.hi)));
}

export interface NestedLodResult {
    readonly coverage: InkCoverage;
    readonly certificate: Readonly<{ areaBoundWorld: number; referenceLowerWorld: number }>;
}

export async function nestedInkLod(fine: InkCoverage, request: InkCoverageRequest, chunkCount: number,
    context: WorkerContext, scratch: (bytes: number) => void): Promise<NestedLodResult | null> {
    const s = fine.segments, n = s.length / 6, scale = request.options.deviceScale;
    if (chunkCount !== 1 || request.range.firstSpan !== 0 || request.range.spanCount !== request.samples.totalCount - 1 ||
        request.options.closed || request.options.dash || request.options.pointMotifs || request.style.model.id !== 'uniform' ||
        request.style.pressure !== 'none' || fine.discs.length || !Number.isSafeInteger(n) || n < 2 ||
        !Number.isFinite(scale) || scale <= 0 || !Number.isFinite(fine.centreErrorWorld) || fine.centreErrorWorld < 0 ||
        !Number.isFinite(fine.radiusErrorWorld) || fine.radiusErrorWorld < 0 || upMul(fine.radiusErrorWorld, scale) > 1 / 16) return null;
    let work = 0, started = performance.now();
    const checkpoint = async () => {
        context.signal.throwIfAborted();
        if (++work >= 256 || performance.now() - started >= 3) { await context.slice(); work = 0; started = performance.now(); context.signal.throwIfAborted(); }
    };
    const r = s[2];
    if (!Number.isFinite(r) || r <= 0) return null;
    let xPositive = true, xNegative = true, yPositive = true, yNegative = true;
    for (let i = 0; i < s.length; i += 6) {
        await checkpoint();
        if (![s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5]].every(Number.isFinite) ||
            s[i + 2] !== r || s[i + 5] !== r || (i && (s[i] !== s[i - 3] || s[i + 1] !== s[i - 2]))) return null;
        xPositive &&= s[i + 3] > s[i]; xNegative &&= s[i + 3] < s[i];
        yPositive &&= s[i + 4] > s[i + 1]; yNegative &&= s[i + 4] < s[i + 1];
    }
    const axis: 0 | 1 = xPositive || xNegative ? 0 : 1;
    if (!(xPositive || xNegative || yPositive || yNegative)) return null;
    const lower = nextDown(3 * nextDown(r * r)), allowed = nextDown(nextDown(lower) * nextDown(0.02));
    if (!(lower > 0) || !Number.isFinite(allowed)) return null;
    let previous: Float64Array | null = null, certificate: NestedLodResult['certificate'] | null = null, maxError = 0;
    for (let group = 2; group / 2 < n; group *= 2) {
        context.signal.throwIfAborted();
        const count = Math.ceil(n / group), candidate = new Float64Array(count * 6);
        scratch((previous?.byteLength ?? 0) + candidate.byteLength);
        let area = 0, levelError = 0, accepted = true;
        for (let first = 0, out = 0; first < n; first += group, out += 6) {
            const last = Math.min(n, first + group), begin = first * 6, end = (last - 1) * 6;
            const ax = s[begin], ay = s[begin + 1], bx = s[end + 3], by = s[end + 4];
            candidate[out] = ax; candidate[out + 1] = ay; candidate[out + 2] = r;
            candidate[out + 3] = bx; candidate[out + 4] = by; candidate[out + 5] = r;
            if (last - first === 1) { await checkpoint(); continue; }
            let delta = 0, finePerimeter = 0;
            for (let index = first; index < last; index++) {
                const i = index * 6;
                delta = Math.max(delta, distanceUpper(s[i], s[i + 1], ax, ay, bx, by, axis),
                    distanceUpper(s[i + 3], s[i + 4], ax, ay, bx, by, axis));
                finePerimeter = upAdd(finePerimeter, perimeter(s[i], s[i + 1], s[i + 3], s[i + 4], r));
                await checkpoint();
            }
            const bound = upAdd(upMul(delta, upAdd(perimeter(ax, ay, bx, by, r), finePerimeter)),
                upMul(upMul(last - first + 1, 22 / 7), upMul(delta, delta)));
            area = upAdd(area, bound); levelError = Math.max(levelError, delta);
            if (!Number.isFinite(area) || area > allowed || !Number.isFinite(levelError) ||
                upMul(upAdd(fine.centreErrorWorld, levelError), scale) > 1 / 16) { accepted = false; break; }
        }
        if (!accepted) break;
        previous = candidate; maxError = levelError;
        certificate = Object.freeze({ areaBoundWorld: area, referenceLowerWorld: lower });
        if (count === 1) break;
    }
    if (!previous || !certificate) return null;
    return { coverage: { ...fine, segments: previous, centreErrorWorld: upAdd(fine.centreErrorWorld, maxError) }, certificate };
}
