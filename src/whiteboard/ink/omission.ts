import type { CanonicalizationCandidate, OmissionCertificate } from './canonicalize';
import { certifyExactCollinear, CANONICALIZATION_DIRECTED_ERROR_DEVICE_PX } from './canonicalize';
import { CurveFlag, writeCurveSpan, type CurveParameters } from './curve';
import type { SampleSequence } from './samples';

function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function split(input: Float64Array, t: number, left: Float64Array, right: Float64Array): void {
    for (let axis = 0; axis < 2; axis++) {
        const a = input[axis], b = input[axis + 2], c = input[axis + 4], d = input[axis + 6];
        const ab = mix(a, b, t), bc = mix(b, c, t), cd = mix(c, d, t);
        const abc = mix(ab, bc, t), bcd = mix(bc, cd, t), middle = mix(abc, bcd, t);
        left[axis] = a; left[axis + 2] = ab; left[axis + 4] = abc; left[axis + 6] = middle;
        right[axis] = middle; right[axis + 2] = bcd; right[axis + 4] = cd; right[axis + 6] = d;
    }
}
function part(input: Float64Array, from: number, to: number, out: Float64Array, scratch: Float64Array): void {
    if (from === 0 && to === 1) { out.set(input); return; }
    split(input, to, out, scratch);
    if (from > 0) { scratch.set(out); split(scratch, from / to, scratch, out); }
}
export function createOmissionCertificate(parameters: CurveParameters): OmissionCertificate {
    const a = new Float64Array(8), b = new Float64Array(8), ca = new Float64Array(8), cb = new Float64Array(8), scratch = new Float64Array(8);
    const arc: number[] = [];
    return (candidate: CanonicalizationCandidate): boolean => {
        if (certifyExactCollinear(candidate)) return true;
        const c = candidate, n = c.rawCount, count = c.retainedCount;
        if (count < 3 || n < 3 || c.pins[c.retained[count - 2]]) return false;
        const removed = c.retained[count - 2];
        // Constant radii make centreline Hausdorff distance a swept-coverage bound. Pressure
        // uncertainty keeps the point; a radius fit must never silently erase an extremum.
        for (let i = 0; i < n; i++) if (c.rawPressure[i] !== c.rawPressure[0]) return false;
        const prefix = c.frozen.count;
        const proposed = c.retained.slice(0, count - 1);
        proposed[count - 2] = c.retained[count - 1];
        const sequence = (indices: ArrayLike<number> | null, size: number): SampleSequence => ({
            count: prefix + size,
            x(i) { return i < prefix ? c.frozen.x(i) : c.rawXY[2 * (indices ? indices[i - prefix] : i - prefix)]; },
            y(i) { return i < prefix ? c.frozen.y(i) : c.rawXY[2 * (indices ? indices[i - prefix] : i - prefix) + 1]; },
            pressure(i) { return i < prefix ? c.frozen.pressure(i) : c.rawPressure[indices ? indices[i - prefix] : i - prefix] < 0 ? undefined : c.rawPressure[indices ? indices[i - prefix] : i - prefix]; },
            segmentKind(i) { return i + 1 < prefix ? c.frozen.segmentKind(i) : c.incomingKinds[indices ? indices[i + 1 - prefix] : i + 1 - prefix] ? 'straight' : 'freehand'; },
        });
        const raw = sequence(null, n), next = sequence(proposed, proposed.length);
        const flagsBefore = writeCurveSpan(raw, prefix + removed - 1, parameters, a);
        const flagsAfter = writeCurveSpan(raw, prefix + removed, parameters, b);
        if ((flagsBefore & CurveFlag.CornerAfter) || (flagsAfter & CurveFlag.CornerBefore)) return false;
        const budget = CANONICALIZATION_DIRECTED_ERROR_DEVICE_PX / c.captureDeviceScale;
        const first = Math.max(-2, -prefix);
        arc.length = 0;
        for (let i = first, total = 0; i < n; i++) {
            if (i > first) total += Math.hypot(raw.x(prefix + i) - raw.x(prefix + i - 1), raw.y(prefix + i) - raw.y(prefix + i - 1));
            arc.push(total);
        }
        const at = (rawIndex: number) => arc[rawIndex - first];
        const compare = (before: SampleSequence, indices: ArrayLike<number> | null, size: number): boolean => {
            let oldSpan = Math.max(0, prefix - 2), newSpan = oldSpan;
            const position = (index: number, map: ArrayLike<number> | null) => index < prefix ? index - prefix : map ? map[index - prefix] : index - prefix;
            for (let rawSpan = Math.max(-2, -prefix); rawSpan < size - 1; rawSpan++) {
                while (oldSpan + 1 < before.count - 1 && position(oldSpan + 1, indices) <= rawSpan) oldSpan++;
                while (newSpan + 1 < next.count - 1 && position(newSpan + 1, proposed) <= rawSpan) newSpan++;
                const old0 = position(oldSpan, indices), old1 = position(oldSpan + 1, indices);
                const new0 = position(newSpan, proposed), new1 = position(newSpan + 1, proposed);
                if (!(old1 > old0 && new1 > new0)) return false;
                writeCurveSpan(before, oldSpan, parameters, a);
                writeCurveSpan(next, newSpan, parameters, b);
                const oldLength = at(old1) - at(old0), newLength = at(new1) - at(new0);
                if (!(oldLength > 0 && newLength > 0)) return false;
                part(a, (at(rawSpan) - at(old0)) / oldLength, Math.min(1, (at(rawSpan + 1) - at(old0)) / oldLength), ca, scratch);
                part(b, (at(rawSpan) - at(new0)) / newLength, Math.min(1, (at(rawSpan + 1) - at(new0)) / newLength), cb, scratch);
                let magnitude = 1, difference = 0;
                for (let i = 0; i < 8; i += 2) {
                    magnitude = Math.max(magnitude, Math.abs(ca[i]), Math.abs(ca[i + 1]), Math.abs(cb[i]), Math.abs(cb[i + 1]));
                    difference = Math.max(difference, Math.hypot(ca[i] - cb[i], ca[i + 1] - cb[i + 1]));
                }
                if (difference + 256 * Number.EPSILON * magnitude > budget) return false;
            }
            return true;
        };
        if (!compare(raw, null, n)) return false;
        if (c.publishedRetainedCount > 1) {
            const published = sequence(c.publishedRetained, c.publishedRetainedCount);
            if (!compare(published, c.publishedRetained, c.publishedRawCount)) return false;
        }
        return true;
    };
}
