import { exactAffinePoint } from './exactAffine';
import { createFillPointJob } from './fillPoint';
import { createSweptPathJob } from './sweptPathJob';
import type { PathOp, Vec2 } from './path';
import type { PathPickOptions } from './pick';
import type { RegionQuery } from './types';

export type PolygonPathResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface PolygonPathLimits { readonly maxWork?: number; readonly maxVertices?: number }
type Polygon = Extract<RegionQuery, { kind: 'polygon' }>;
const PENDING: PolygonPathResult = Object.freeze({ status: 'pending' });

/** Resumable region/path intersection and containment. Boundary crossings use
 * the same certified swept job; disconnected subpaths each retain a witness. */
export function createPolygonPathJob(paths: readonly (readonly PathOp[])[], query: Polygon, options: PathPickOptions,
    limits: PolygonPathLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): PolygonPathResult; cancel(): void } {
    const maxWork = limits.maxWork ?? 3000000, maxVertices = limits.maxVertices ?? 131072;
    if (query.points.length < 3 || !Number.isSafeInteger(maxWork) || maxWork < 1 || !Number.isSafeInteger(maxVertices) || maxVertices < 3
        || query.points.length > maxVertices || !query.localToSurface.every(Number.isFinite) || !Number.isSafeInteger(options.maxSegments) || options.maxSegments < 1)
        throw new RangeError('Invalid polygon path job');
    const ring: Vec2[] = [], polygon: PathOp[] = [], allPaths = [...paths, ...(options.interiorPaths ?? [])];
    let finished: PolygonPathResult | undefined, cancelled = false, spent = 0, phase: 'ring' | 'boundary' | 'query' | 'source' = 'ring';
    let cursor = 0, pathIndex = 0, commandIndex = 0, commands = 0, hasGeometry = false, uncertain = false;
    let subpathStart: Vec2 | undefined, probeSubpath = false;
    let boundary: ReturnType<typeof createSweptPathJob> | undefined, fill: ReturnType<typeof createFillPointJob> | undefined;
    const finish = (result: PolygonPathResult): PolygonPathResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid polygon path slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Polygon path job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Polygon path work limit exhausted' });
                if (phase === 'ring') {
                    if (cursor < query.points.length) {
                        const point = query.points[cursor++]; if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid polygon point');
                        ring.push({ x: point.x, y: point.y }); polygon.push({ op: cursor === 1 ? 'M' : 'L', p: { x: point.x, y: point.y } }); continue;
                    }
                    ring.push(ring[0]); polygon.push({ op: 'Z' }); cursor = 0;
                    boundary = createSweptPathJob(paths, { kind: 'swept', points: ring, radiusCss: 0, localToSurface: query.localToSurface }, options,
                        { probeInterior: false });
                    phase = 'boundary'; continue;
                }
                if (phase === 'boundary') {
                    const state = boundary!.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    boundary!.cancel(); boundary = undefined;
                    if (state.status === 'hit') return finish({ status: query.containment ? 'miss' : 'hit' });
                    if (state.status === 'uncertain') uncertain = true;
                    phase = query.containment ? 'source' : 'query'; continue;
                }
                if (phase === 'query') {
                    if (!options.interiorPaths?.length || cursor >= query.points.length) { cursor = 0; phase = 'source'; continue; }
                    if (!fill) fill = createFillPointJob(options.interiorPaths, query.points[cursor], 'nonzero',
                        { localToWorld: query.localToSurface, maxCommands: options.maxSegments });
                    const state = fill.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    if (state.status === 'inside') return finish({ status: 'hit' });
                    if (state.status === 'uncertain') uncertain = true;
                    fill = undefined; cursor++; continue;
                }
                if (fill) {
                    const state = fill.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    fill = undefined;
                    if (state.status === 'uncertain') uncertain = true;
                    else if (query.containment ? state.status === 'outside' : state.status === 'inside') return finish({ status: query.containment ? 'miss' : 'hit' });
                    continue;
                }
                if (pathIndex >= allPaths.length) {
                    if (!hasGeometry) return finish({ status: 'miss' });
                    return finish(uncertain ? { status: 'uncertain', reason: 'Polygon/path boundary cannot be certified' }
                        : { status: query.containment ? 'hit' : 'miss' });
                }
                const path = allPaths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; subpathStart = undefined; probeSubpath = false; continue; }
                if (++commands > options.maxSegments * 2) return finish({ status: 'uncertain', reason: 'Polygon/path command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { subpathStart = op.p; probeSubpath = true; continue; }
                if (!subpathStart) throw new RangeError('Polygon path must begin with M');
                if (probeSubpath) {
                    hasGeometry = true; probeSubpath = false;
                    const exact = exactAffinePoint(query.localToSurface, subpathStart);
                    fill = createFillPointJob([polygon], { x: 0, y: 0 }, 'nonzero', { exactPoint: exact, maxCommands: maxVertices + 1 });
                }
            }
            return PENDING;
        },
        cancel() { cancelled = true; boundary?.cancel(); boundary = undefined; },
    };
}
