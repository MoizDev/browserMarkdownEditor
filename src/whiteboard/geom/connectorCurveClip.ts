import { exactAffinePoint } from './exactAffine';
import { exactIntersection, exactLineBetween, exactLineThrough, exactPoint, exactSide, sameExactPoint, type ExactPoint } from './homogeneous';
import { createFillPointJob } from './fillPoint';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import { dyadicRatioInterval } from './dyadicRatio';
import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import type { Vec2 } from './path';
import type { ExactConnectorContour, ExactConnectorCrossing } from './connectorExactClip';

interface RootBand { readonly lo: number; readonly hi: number; readonly exact?: ExactPoint }
interface CurveWork { readonly curve: ExactCurve; readonly depth: number }
const ONE: Dyadic = Object.freeze({ n: 1n, e: 0 });
function sum(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function weighted(point: ExactCurve[number]): ExactPoint { return { x: point.x, y: point.y, w: ONE }; }
function position(start: Vec2, end: Vec2, t: number): ExactPoint {
    const interpolate = (a: number, b: number) => sum(dyadic(a), dyadicMultiply(dyadic(t), dyadicSubtract(dyadic(b), dyadic(a))));
    return { x: interpolate(start.x, end.x), y: interpolate(start.y, end.y), w: ONE };
}
function parameter(point: ExactPoint, start: Vec2, end: Vec2): { readonly lo: number; readonly hi: number } {
    const axis = start.x !== end.x ? 'x' : 'y', origin = dyadic(start[axis]);
    let numerator = dyadicSubtract(point[axis], dyadicMultiply(origin, point.w));
    let denominator = dyadicMultiply(dyadicSubtract(dyadic(end[axis]), origin), point.w);
    if (!denominator.n) throw new RangeError('Degenerate connector line');
    if (denominator.n < 0n) { numerator = { n: -numerator.n, e: numerator.e }; denominator = { n: -denominator.n, e: denominator.e }; }
    return dyadicRatioInterval(numerator, denominator);
}
function signChanges(signs: readonly number[]): number {
    let previous = 0, count = 0;
    for (const sign of signs) { if (!sign) continue; if (previous && sign !== previous) count++; previous = sign; }
    return count;
}
function* sortBands(input: readonly RootBand[]): Generator<void, RootBand[]> {
    let values: RootBand[] = [], buffer = new Array<RootBand>(input.length);
    for (const band of input) { values.push(band); yield; }
    for (let width = 1; width < values.length; width *= 2) {
        for (let start = 0; start < values.length; start += 2 * width) {
            const middle = Math.min(start + width, values.length), end = Math.min(start + 2 * width, values.length);
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

/** Certified straight-body crossings of closed line/cubic attachment contours.
 * Bernstein variation bounds isolate every simple crossing. Tangencies,
 * collinear overlap and unresolved overlapping roots fail explicitly. */
export function* curvedConnectorLineCrossings(start: Vec2, end: Vec2, length: number, contours: readonly ExactConnectorContour[],
    error: number, maxPieces: number): Generator<void, readonly ExactConnectorCrossing[]> {
    if (![start.x, start.y, end.x, end.y, length, error].every(Number.isFinite) || length <= 0 || error <= 0
        || !Number.isSafeInteger(maxPieces) || maxPieces < 1 || contours.length > 65) throw new RangeError('Invalid curved connector clipping');
    const first = exactPoint(start), last = exactPoint(end);
    if (sameExactPoint(first, last)) throw new RangeError('Nonzero connector has coincident ends');
    const line = exactLineThrough(start, end), bands: RootBand[] = [];
    let nodes = 0, commands = 0;
    const add = (band: RootBand) => {
        if (bands.length >= maxPieces) throw new RangeError('Connector crossing budget exhausted');
        if (![band.lo, band.hi].every(Number.isFinite) || band.lo > band.hi) throw new RangeError('Connector root interval is invalid');
        bands.push(band);
    };
    const endpoint = (point: ExactPoint) => {
        const t = parameter(point, start, end);
        if (t.hi < 0 || t.lo > 1) return;
        if (sameExactPoint(point, first) || sameExactPoint(point, last)) return;
        if (!(t.lo > 0 && t.hi < 1) || (t.hi - t.lo) * length > error) throw new RangeError('Connector endpoint crossing cannot be represented');
        add({ lo: t.lo, hi: t.hi, exact: point });
    };
    const segment = (a: ExactPoint, b: ExactPoint) => {
        if (sameExactPoint(a, b)) return;
        const sa = exactSide(line, a), sb = exactSide(line, b);
        if (!sa && !sb) throw new RangeError('Connector lies along an attachment boundary');
        if (!sa) { endpoint(a); return; }
        if (!sb) { endpoint(b); return; }
        if (sa === sb) return;
        const point = exactIntersection(line, exactLineBetween(a, b));
        if (!point) throw new RangeError('Connector boundary intersection is parallel');
        endpoint(point);
    };
    const cubic = function* (points: ExactCurve): Generator<void, void> {
        const stack: CurveWork[] = [{ curve: points, depth: 0 }];
        while (stack.length) {
            if (++nodes > maxPieces * 64) throw new RangeError('Connector curve root budget exhausted');
            const item = stack.pop()!, p = item.curve.map(weighted), signs = p.map(point => exactSide(line, point));
            if (signs.every(sign => !sign)) throw new RangeError('Connector lies along a curved attachment boundary');
            if (!signs[0]) endpoint(p[0]);
            if (!signs[signs.length - 1]) endpoint(p[p.length - 1]);
            const variations = signChanges(signs);
            if (!variations) { yield; continue; }
            let lo = Infinity, hi = -Infinity;
            for (const point of p) { const t = parameter(point, start, end); lo = Math.min(lo, t.lo); hi = Math.max(hi, t.hi); }
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new RangeError('Connector curve projection overflows');
            if (hi < 0 || lo > 1) { yield; continue; }
            if (variations === 1 && lo > 0 && hi < 1 && (hi - lo) * length <= error) { add({ lo, hi }); yield; continue; }
            if (item.depth >= 64 || nodes + stack.length + 2 > maxPieces * 64) throw new RangeError('Connector curve root cannot be isolated');
            const [left, right] = splitExactCurve(item.curve);
            stack.push({ curve: right, depth: item.depth + 1 }, { curve: left, depth: item.depth + 1 }); yield;
        }
    };
    for (const contour of contours) {
        let current: ExactPoint | undefined, begin: ExactPoint | undefined;
        const map = (point: Vec2) => exactAffinePoint(contour.localToWorld, point);
        for (const op of contour.outline) {
            if (++commands > maxPieces * contours.length) throw new RangeError('Connector contour command budget exhausted');
            if (op.op === 'M') {
                if (current && begin) segment(current, begin);
                current = begin = map(op.p); yield; continue;
            }
            if (!current || !begin) throw new RangeError('Attachment contour must begin with a move');
            if (op.op === 'Z') { segment(current, begin); current = begin; yield; continue; }
            const endPoint = map(op.p);
            if (op.op === 'L') segment(current, endPoint);
            else yield* cubic([current, map(op.c1), map(op.c2), endPoint]);
            current = endPoint; yield;
        }
        if (current && begin) segment(current, begin);
    }
    const sorted = yield* sortBands(bands), roots: RootBand[] = [];
    for (const band of sorted) {
        const previous = roots[roots.length - 1];
        if (previous && previous.hi >= band.lo) {
            if (previous.exact && band.exact && sameExactPoint(previous.exact, band.exact)) { yield; continue; }
            throw new RangeError('Connector boundary crossings cannot be separated');
        }
        roots.push(band); yield;
    }
    const states: boolean[] = [];
    for (let i = 0; i <= roots.length; i++) {
        const lo = i ? roots[i - 1].hi : 0, hi = i < roots.length ? roots[i].lo : 1;
        const t = lo / 2 + hi / 2;
        if (!(lo < t && t < hi)) throw new RangeError('Connector crossing gap has no representable sample');
        const query = position(start, end, t); let inside = true;
        for (const contour of contours) {
            const job = createFillPointJob([contour.outline], { x: 0, y: 0 }, 'nonzero', { exactPoint: query, localToWorld: contour.localToWorld, maxCommands: maxPieces });
            for (;;) {
                const result = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                if (result.status === 'pending') { yield; continue; }
                if (result.status === 'uncertain') throw new RangeError(result.reason);
                if (result.status === 'outside') inside = false;
                break;
            }
            yield; if (!inside) break;
        }
        states.push(inside); yield;
    }
    const crossings: ExactConnectorCrossing[] = [];
    for (let i = 0; i < roots.length; i++) {
        if (states[i] !== states[i + 1]) {
            const t = roots[i].lo / 2 + roots[i].hi / 2, distance = t * length;
            if (!(distance > 0 && distance < length)) throw new RangeError('Connector crossing distance is not representable');
            crossings.push(Object.freeze({ distance, entering: states[i + 1] }));
        }
        yield;
    }
    return Object.freeze(crossings);
}
