import { exactAffinePoint } from './exactAffine';
import type { ExactPoint } from './homogeneous';
import { sameExactPoint } from './homogeneous';
import { createCurveCircleRootsJob } from './curveCircleRoots';
import type { ExactCurve } from './exactCurve';
import type { Vec2 } from './path';
import type { ExactConnectorContour } from './connectorExactClip';

/** A complete circle disjoint from every boundary cannot produce an arc
 * crossing. Any numerical or budget uncertainty leaves the normal path in
 * charge; this is an early-out certificate, never an approximate miss. */
export function* connectorCircleBoundaryDisjoint(centre: Vec2, radius: number, contours: readonly ExactConnectorContour[],
    error: number, maxPieces: number): Generator<void, boolean> {
    if (![centre.x, centre.y, radius, error].every(Number.isFinite) || radius <= 0 || error <= 0
        || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid connector circle preflight');
    let commands = 0;
    const check = function* (curve: ExactCurve): Generator<void, boolean> {
        const job = createCurveCircleRootsJob(curve, centre, radius, { width: error, maxRoots: 16,
            maxNodes: Math.min(262144, Math.max(1, maxPieces * 64)) });
        try {
            for (;;) {
                const result = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                if (result.status === 'pending') { yield; continue; }
                return result.status === 'done' && result.roots.length === 0;
            }
        } finally { job.cancel(); }
    };
    for (const contour of contours) {
        let begin: ExactPoint | undefined, current: ExactPoint | undefined;
        const line = function* (a: ExactPoint, b: ExactPoint): Generator<void, boolean> {
            return sameExactPoint(a, b) ? true : (yield* check([a, b]));
        };
        for (const op of contour.outline) {
            if (++commands > maxPieces * contours.length) return false;
            if (op.op === 'M') {
                if (current && begin && !(yield* line(current, begin))) return false;
                current = begin = exactAffinePoint(contour.localToWorld, op.p); yield; continue;
            }
            if (!current || !begin) return false;
            if (op.op === 'Z') { if (!(yield* line(current, begin))) return false; current = begin; yield; continue; }
            const next = exactAffinePoint(contour.localToWorld, op.p);
            if (op.op === 'L') { if (!(yield* line(current, next))) return false; }
            else if (!(yield* check([current, exactAffinePoint(contour.localToWorld, op.c1), exactAffinePoint(contour.localToWorld, op.c2), next]))) return false;
            current = next; yield;
        }
        if (current && begin && !(yield* line(current, begin))) return false;
    }
    return true;
}
