import type { WorkerContext } from '../../platform/workers';
import { nextDown, nextUp } from '../geom/numeric';
import type { InkCoverageReply } from './geometryProtocol';

// For convex sets within Hausdorff distance d, their symmetric difference is contained in
// the two d-offset rings. Steiner's formula bounds those rings by d(Pa+Pb)+2πd².
// Summing over paired capsules/discs also bounds the difference of their unions.
const add = (a: number, b: number) => a === 0 && b === 0 ? 0 : nextUp(a + b);
const mul = (a: number, b: number) => a === 0 || b === 0 ? 0 : nextUp(a * b);
const difference = (a: number, b: number) => a === b ? 0 : nextUp(Math.abs(a - b));
const displacement = (a: Float64Array, b: Float64Array, i: number) =>
    add(add(difference(a[i], b[i]), difference(a[i + 1], b[i + 1])), difference(a[i + 2], b[i + 2]));
const capsulePerimeter = (a: Float64Array, i: number) => add(mul(2, add(difference(a[i], a[i + 3]),
    difference(a[i + 1], a[i + 4]))), mul(8, Math.max(a[i + 2], a[i + 5])));
const discPerimeter = (a: Float64Array, i: number) => mul(8, a[i + 2]);
const finiteRows = (a: Float64Array, b: Float64Array, i: number, count: number): boolean => {
    for (let j = i; j < i + count; j++) if (!Number.isFinite(a[j]) || !Number.isFinite(b[j])) return false;
    return true;
};

/** Returns a conservative bound, or null when correspondence or arithmetic is uncertain. */
export async function certifyLod(fine: InkCoverageReply, coarse: InkCoverageReply, actualScale: number,
    chunkCount: number, context: WorkerContext): Promise<Readonly<{ areaBoundWorld: number; referenceLowerWorld: number }> | null> {
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || !Number.isFinite(actualScale) || actualScale <= 0
        || fine.segments.length !== coarse.segments.length || fine.discs.length !== coarse.discs.length
        || fine.segments.length % 6 || fine.discs.length % 3
        || fine.geometry.originX !== coarse.geometry.originX || fine.geometry.originY !== coarse.geometry.originY) return null;
    const error = add(add(coarse.centreErrorWorld, coarse.radiusErrorWorld), coarse.dashPhaseErrorWorld);
    if (!Number.isFinite(error) || error < 0 || mul(error, actualScale) > 0.125) return null;
    let area = 0, maxRadius = 0, work = 0, started = performance.now();
    const cooperate = async () => { await context.slice(); work = 0; started = performance.now(); };
    const bound = (d: number, p: number) => add(mul(d, p), mul(44 / 7, mul(d, d)));
    for (let i = 0; i < fine.segments.length; i += 6) {
        if (++work >= 256 || performance.now() - started >= 3) await cooperate();
        const a = fine.segments, b = coarse.segments;
        if (!finiteRows(a, b, i, 6)
            || a[i + 2] < 0 || a[i + 5] < 0 || b[i + 2] < 0 || b[i + 5] < 0) return null;
        maxRadius = Math.max(maxRadius, a[i + 2], a[i + 5]);
        const d = Math.max(displacement(a, b, i), displacement(a, b, i + 3));
        area = add(area, bound(d, add(capsulePerimeter(a, i), capsulePerimeter(b, i))));
    }
    for (let i = 0; i < fine.discs.length; i += 3) {
        if (++work >= 256 || performance.now() - started >= 3) await cooperate();
        const a = fine.discs, b = coarse.discs;
        if (!finiteRows(a, b, i, 3) || a[i + 2] < 0 || b[i + 2] < 0) return null;
        maxRadius = Math.max(maxRadius, a[i + 2]);
        area = add(area, bound(displacement(a, b, i), add(discPerimeter(a, i), discPerimeter(b, i))));
    }
    const square = nextDown(maxRadius * maxRadius), lower = nextDown(3 * square);
    const allowed = nextDown(nextDown(lower / chunkCount) * nextDown(0.02));
    if (!Number.isFinite(area) || !Number.isFinite(lower) || lower <= 0 || area > allowed) return null;
    return Object.freeze({ areaBoundWorld: area, referenceLowerWorld: lower });
}
