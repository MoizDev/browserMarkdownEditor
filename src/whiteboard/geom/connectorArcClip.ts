import { exactAffinePoint } from './exactAffine';
import type { ExactPoint } from './homogeneous';
import { sameExactPoint } from './homogeneous';
import { createCurveCircleRootsJob, type CircleRootBox } from './curveCircleRoots';
import { createContourBoxFillJob } from './contourBoxFillJob';
import { certifiedAngleBox, certifiedPi, certifiedSinCos } from './certifiedAngle';
import { add, divide, dyadic, dyadicSubtract, interval, multiply, subtract, type Interval } from './numeric';
import type { ExactCurve } from './exactCurve';
import type { Vec2 } from './path';
import type { ExactConnectorContour, ExactConnectorCrossing } from './connectorExactClip';

interface RootBand { readonly lo: number; readonly hi: number; readonly exact?: CircleRootBox['exact'] }
interface ArcGeometry { readonly centre: Vec2; readonly radius: number; readonly start: number; readonly sweep: number }
function equalExact(a: NonNullable<RootBand['exact']>, b: NonNullable<RootBand['exact']>): boolean {
    return dyadicSubtract(a.x, b.x).n === 0n && dyadicSubtract(a.y, b.y).n === 0n;
}
function* sortBands(input: readonly RootBand[]): Generator<void, RootBand[]> {
    let values: RootBand[] = [], buffer = new Array<RootBand>(input.length);
    for (const item of input) { values.push(item); yield; }
    for (let width = 1; width < values.length; width *= 2) {
        for (let start = 0; start < values.length; start += width * 2) {
            const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
            let a = start, b = middle;
            for (let i = start; i < end; i++) {
                buffer[i] = a < middle && (b >= end || values[a].lo < values[b].lo || (values[a].lo === values[b].lo && values[a].hi <= values[b].hi)) ? values[a++] : values[b++];
                yield;
            }
        }
        [values, buffer] = [buffer, values];
    }
    return values;
}
function angleStart(start: number, period: Interval): Interval {
    if (start === 0) return interval(0);
    const approximatePeriod = period.lo / 2 + period.hi / 2, turns = Math.floor(start / approximatePeriod);
    if (!Number.isSafeInteger(turns)) throw new RangeError('Connector arc angle cannot be reduced');
    let result = subtract(interval(start), multiply(interval(turns), period));
    if (result.hi < 0) result = add(result, period);
    if (result.lo >= period.hi) result = subtract(result, period);
    if (result.lo < 0 || result.hi > period.hi) throw new RangeError('Connector arc start lies on an uncertain angle seam');
    return result;
}
function rootAngle(root: CircleRootBox, centre: Vec2): Interval | null {
    let x = subtract(root.x, interval(centre.x)), y = subtract(root.y, interval(centre.y));
    if (root.exact && !dyadicSubtract(root.exact.x, dyadic(centre.x)).n) x = interval(0);
    if (root.exact && !dyadicSubtract(root.exact.y, dyadic(centre.y)).n) y = interval(0);
    return certifiedAngleBox(x, y);
}

export function* certifiedConnectorArcCrossings(arc: ArcGeometry, length: number, contours: readonly ExactConnectorContour[],
    error: number, maxPieces: number): Generator<void, readonly ExactConnectorCrossing[]> {
    if (![arc.centre.x, arc.centre.y, arc.radius, arc.start, arc.sweep, length, error].every(Number.isFinite) || arc.radius <= 0
        || !arc.sweep || length <= 0 || error <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1 || contours.length > 65)
        throw new RangeError('Invalid certified connector arc');
    const period = multiply(certifiedPi(), interval(2));
    if (Math.abs(arc.sweep) > period.hi) throw new RangeError('Connector arc makes more than one turn');
    const start = angleStart(arc.start, period); let width = error, roots: RootBand[] | undefined;
    for (let pass = 0; pass < 32; pass++) {
        const bands: RootBand[] = []; let retry = false, commands = 0;
        const emit = (root: CircleRootBox) => {
            const angle = rootAngle(root, arc.centre); if (!angle) { retry = true; return; }
            for (let turn = -2; turn <= 2; turn++) {
                const unwrapped = add(angle, multiply(interval(turn), period));
                const t = divide(subtract(unwrapped, start), interval(arc.sweep));
                if (!Number.isFinite(t.lo) || !Number.isFinite(t.hi)) { retry = true; continue; }
                if (t.hi < 0 || t.lo > 1) continue;
                if (!(t.lo > 0 && t.hi < 1) || (t.hi - t.lo) * length > error) { retry = true; continue; }
                if (bands.length >= maxPieces) throw new RangeError('Connector arc root budget exhausted');
                bands.push({ lo: t.lo, hi: t.hi, exact: root.exact });
            }
        };
        const check = function* (curve: ExactCurve): Generator<void, void> {
            const job = createCurveCircleRootsJob(curve, arc.centre, arc.radius, { width, maxRoots: 16,
                maxNodes: Math.min(262144, Math.max(1, maxPieces * 64)) });
            try {
                for (;;) {
                    const result = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                    if (result.status === 'pending') { yield; continue; }
                    if (result.status === 'uncertain') throw new RangeError(result.reason);
                    for (const root of result.roots) { emit(root); yield; }
                    return;
                }
            } finally { job.cancel(); }
        };
        for (const contour of contours) {
            let begin: ExactPoint | undefined, current: ExactPoint | undefined;
            const line = function* (a: ExactPoint, b: ExactPoint): Generator<void, void> { if (!sameExactPoint(a, b)) yield* check([a, b]); };
            for (const op of contour.outline) {
                if (++commands > maxPieces * contours.length) throw new RangeError('Connector arc contour budget exhausted');
                if (op.op === 'M') {
                    if (current && begin) yield* line(current, begin);
                    current = begin = exactAffinePoint(contour.localToWorld, op.p); yield; continue;
                }
                if (!current || !begin) throw new RangeError('Attachment contour must start with a move');
                if (op.op === 'Z') { yield* line(current, begin); current = begin; yield; continue; }
                const next = exactAffinePoint(contour.localToWorld, op.p);
                if (op.op === 'L') yield* line(current, next);
                else if (op.op === 'C') yield* check([current, exactAffinePoint(contour.localToWorld, op.c1), exactAffinePoint(contour.localToWorld, op.c2), next]);
                current = next; yield;
            }
            if (current && begin) yield* line(current, begin);
        }
        const sorted = yield* sortBands(bands), distinct: RootBand[] = [];
        for (const band of sorted) {
            const prior = distinct[distinct.length - 1];
            if (prior && prior.hi >= band.lo) {
                if (prior.exact && band.exact && equalExact(prior.exact, band.exact)) { yield; continue; }
                retry = true; break;
            }
            distinct.push(band); yield;
        }
        if (!retry) { roots = distinct; break; }
        width /= 4; if (!(width > 0)) throw new RangeError('Connector arc roots cannot be separated'); yield;
    }
    if (!roots) throw new RangeError('Connector arc roots cannot be separated');
    const states: boolean[] = [];
    for (let i = 0; i <= roots.length; i++) {
        const lo = i ? roots[i - 1].hi : 0, hi = i < roots.length ? roots[i].lo : 1, t = lo / 2 + hi / 2;
        if (!(lo < t && t < hi)) throw new RangeError('Connector arc gap has no representable sample');
        const angle = add(interval(arc.start), multiply(interval(arc.sweep), interval(t))), trig = certifiedSinCos(angle);
        if (!trig) throw new RangeError('Connector arc sample angle cannot be enclosed');
        const x = add(interval(arc.centre.x), multiply(interval(arc.radius), trig.cos));
        const y = add(interval(arc.centre.y), multiply(interval(arc.radius), trig.sin));
        const box = [x.lo, y.lo, x.hi, y.hi] as const;
        if (!box.every(Number.isFinite)) throw new RangeError('Connector arc sample overflows');
        let inside = true;
        for (const contour of contours) {
            const fill = createContourBoxFillJob(contour.outline, contour.localToWorld, box, { maxCommands: maxPieces });
            try {
                for (;;) {
                    const result = fill.step({ deadline: performance.now() + 3, maxWork: 1 });
                    if (result.status === 'pending') { yield; continue; }
                    if (result.status === 'uncertain') throw new RangeError(result.reason);
                    if (result.status === 'outside') inside = false;
                    break;
                }
            } finally { fill.cancel(); }
            yield; if (!inside) break;
        }
        states.push(inside); yield;
    }
    const crossings: ExactConnectorCrossing[] = [];
    for (let i = 0; i < roots.length; i++) {
        if (states[i] !== states[i + 1]) {
            const distance = (roots[i].lo / 2 + roots[i].hi / 2) * length;
            if (!(distance > 0 && distance < length)) throw new RangeError('Connector arc crossing is not representable');
            crossings.push(Object.freeze({ distance, entering: states[i + 1] }));
        }
        yield;
    }
    return Object.freeze(crossings);
}
