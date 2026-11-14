import type { Affine, ViewState } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { worldPose } from '../change/coordinates';
import { compose, inverse } from '../geom/affine';
import { regionPath } from '../geom/pick';
import { resolvePolylineAttachments } from '../geom/polylineAttachments';
import { preparePolylineGeometry } from '../geom/providers';
import { orient2d } from '../geom/predicates';
import { exactAffinePoint } from '../geom/exactAffine';
import { exactIntersection, exactLineBetween, exactPoint, exactPointIntervals, exactSide, type ExactPoint } from '../geom/homogeneous';
import type { PathOp, Vec2 } from '../geom/path';
import type { RegionQuery } from '../geom/types';
import type { BoardRuntime } from '../host/runtime';
import { InkRegionPickJob } from '../ink/regionPick';
import type { NodeId } from '../model/ids';
import type { Attachment, Node } from '../model/nodes';
import type { SpatialRef } from '../pick';
import { BoundsQuality } from '../scene/bounds';
import type { createBoardRenderServices } from '../render/services';
import { selectableAtFocus } from '../selection';

// Provenance: Scene spatial cursor, GE-3 region providers, C7 stamps and
// nonzero clipping contracts; independent composition, no third-party source.
export class BoardRegionUncertain extends Error {
    constructor(message: string) { super(message); this.name = 'BoardRegionUncertain'; }
}
type Geometry = ReturnType<typeof createBoardRenderServices>;
export interface BoardRegionQueryOptions {
    readonly runtime: BoardRuntime;
    readonly geometry: Pick<Geometry, 'prepareForPick'>;
    fontEpoch(): number;
    camera(): ViewState;
    current(token: RenderToken): boolean;
    cooperate?(): Promise<void>;
    onError(error: unknown): void;
}
function matrix(doc: BoardRuntime['session']['doc'], id: NodeId): Affine {
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return [c, s, -s, c, pose.x, pose.y];
}
function rectPath(x: number, y: number, w: number, h: number): readonly PathOp[] {
    return [{ op: 'M', p: { x, y } }, { op: 'L', p: { x: x + w, y } },
        { op: 'L', p: { x: x + w, y: y + h } }, { op: 'L', p: { x, y: y + h } }, { op: 'Z' }];
}
function stampView(a: ViewState, b: ViewState): boolean {
    return a.epoch === b.epoch && a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
        && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.viewport.dpr === b.viewport.dpr;
}
function stale(): DOMException { return new DOMException('Board region query became stale', 'AbortError'); }
function clipPolygon(subject: readonly Vec2[], clip: readonly ExactPoint[]): Vec2[] {
    // A single polygon cannot represent a disconnected intersection of a concave lasso and frame.
    if (subject.length < 3 || subject.length > 4) throw new BoardRegionUncertain('Frame clipping requires a certified convex region');
    let winding = 0;
    for (let i = 0; i < subject.length; i++) {
        const side = orient2d(subject[i], subject[(i + 1) % subject.length], subject[(i + 2) % subject.length]);
        if (!side || (winding && Math.sign(side) !== winding)) throw new BoardRegionUncertain('Frame clipping requires a certified convex region');
        winding = Math.sign(side);
    }
    let result = subject.map(exactPoint);
    for (let side = 0; side < 4 && result.length; side++) {
        const line = exactLineBetween(clip[side], clip[(side + 1) % 4]), input = result; result = [];
        let previous = input[input.length - 1], prevSide = exactSide(line, previous);
        for (const point of input) {
            const currentSide = exactSide(line, point);
            if ((currentSide >= 0) !== (prevSide >= 0)) {
                const intersection = exactIntersection(line, exactLineBetween(previous, point));
                if (!intersection) throw new BoardRegionUncertain('Frame intersection is numerically ambiguous');
                result.push(intersection);
            }
            if (currentSide >= 0) result.push(point);
            previous = point; prevSide = currentSide;
        }
    }
    return result.map(point => {
        const intervals = exactPointIntervals(point);
        if (intervals.x.lo !== intervals.x.hi || intervals.y.lo !== intervals.y.hi)
            throw new BoardRegionUncertain('Frame intersection cannot be represented exactly');
        return { x: intervals.x.lo, y: intervals.y.lo };
    });
}
export function createBoardRegionQuery(options: BoardRegionQueryOptions) {
    const { runtime } = options;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    async function region(query: RegionQuery, signal: AbortSignal): Promise<readonly NodeId[]> {
        let cursor: ReturnType<NonNullable<typeof runtime.scene>['spatialCursor']> | undefined;
        try {
            signal.throwIfAborted();
            const doc = runtime.session.doc, scene = runtime.scene;
            if (!scene || !scene.ready) throw new BoardRegionUncertain('Board scene is not ready');
            const pin = scene.pin(); let token: RenderToken;
            try { token = Object.freeze({ ...pin.token }); } finally { pin.release(); }
            const view = options.camera(), camera = Object.freeze({ ...view.camera }), viewport = Object.freeze({ ...view.viewport });
            const viewStamp: ViewState = { ...view, camera, viewport }, revision = doc.rev, font = options.fontEpoch();
            const selection = runtime.selection.getSnapshot(), { sheet, focus } = selection;
            const check = () => {
                signal.throwIfAborted();
                const next = runtime.selection.getSnapshot();
                if (!options.current(token) || runtime.scene !== scene || !scene.ready || scene.revision !== revision || doc.rev !== revision
                    || options.fontEpoch() !== font || !stampView(viewStamp, options.camera()) || next.sheet !== sheet || next.focus !== focus) throw stale();
            };
            if (!Number.isFinite(camera.z) || camera.z <= 0 || !Number.isFinite(viewport.dpr) || viewport.dpr <= 0
                || (query.kind === 'polygon' ? query.points.length < 3 : !query.points.length || !Number.isFinite(query.radiusCss) || query.radiusCss < 0)) throw new RangeError('Invalid board region');
            const points: Vec2[] = []; let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < query.points.length; i++) {
                const p = query.points[i];
                if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError('Invalid board region point');
                points.push({ x: p.x, y: p.y }); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
                if ((i & 255) === 255) { await cooperate(); check(); }
            }
            check();
            const margin = query.kind === 'swept' ? query.radiusCss : 0;
            const worldBox: [number, number, number, number] = [camera.x + (minX - margin) / camera.z, camera.y + (minY - margin) / camera.z,
                camera.x + (maxX + margin) / camera.z, camera.y + (maxY + margin) / camera.z];
            if (!worldBox.every(Number.isFinite)) throw new RangeError('Board region bounds overflow');
            const worldToCss: Affine = [camera.z, 0, 0, camera.z, -camera.x * camera.z, -camera.y * camera.z];
            const queue: SpatialRef[] = [], hits = new Map<NodeId, number>();
            cursor = scene.spatialCursor({ sheetId: sheet, purpose: 'selectable', request: { kind: 'box', box: worldBox, order: 'forward' } });
            const narrow = async (ref: SpatialRef) => {
                check();
                const resolved = scene.resolveSpatial(ref);
                if (!resolved) throw stale();
                const node = doc.nodes.get(resolved.id);
                if (!node || node.kind === 'group') return;
                const selected = selectableAtFocus(doc, node.id, focus, sheet);
                if (!selected) return;
                if (query.kind === 'polygon' && query.containment && selected !== node.id) throw new BoardRegionUncertain('Group containment requires all visible children');
                let localPoints: readonly Vec2[] = points;
                let ancestor = doc.nodes.get(node.parent as NodeId);
                for (let depth = 0; ancestor && depth < 64; depth++) {
                    if (ancestor.kind === 'frame') {
                        const frameWorld = matrix(doc, ancestor.id), toFrame = inverse(frameWorld, 1e12), record = scene.worldBounds(node.id);
                        const bounds = record && (record.quality === BoundsQuality.Exact || record.quality === BoundsQuality.Conservative)
                            ? record.selectable : null;
                        if (!toFrame || !bounds) throw new BoardRegionUncertain('Frame-clipped selection has no certified bounds');
                        const corners = [{ x: bounds[0], y: bounds[1] }, { x: bounds[2], y: bounds[1] },
                            { x: bounds[2], y: bounds[3] }, { x: bounds[0], y: bounds[3] }].map(p => exactPointIntervals(exactAffinePoint(toFrame, p)));
                        const frame = ancestor;
                        const fullyVisible = corners.every(p => p.x.lo > 0 && p.y.lo > 0 && p.x.hi < frame.w && p.y.hi < frame.h);
                        if (!fullyVisible) {
                            if (query.kind === 'swept' || query.containment) throw new BoardRegionUncertain('Frame-clipped region needs visible-extent certification');
                            const frameCss = compose(worldToCss, frameWorld), polygon = [{ x: 0, y: 0 }, { x: ancestor.w, y: 0 },
                                { x: ancestor.w, y: ancestor.h }, { x: 0, y: ancestor.h }].map(p => exactAffinePoint(frameCss, p));
                            localPoints = clipPolygon(localPoints, polygon);
                            if (!localPoints.length) return;
                            if (localPoints.length < 3) throw new BoardRegionUncertain('Frame-clipped polygon has a degenerate intersection');
                        }
                    }
                    ancestor = doc.nodes.get(ancestor.parent as NodeId);
                }
                const prepared = await options.geometry.prepareForPick(node, signal); check();
                const localToSurface = compose(worldToCss, ref.localToWorld);
                const localQuery: RegionQuery = query.kind === 'polygon'
                    ? { kind: 'polygon', points: localPoints, localToSurface, containment: query.containment }
                    : { kind: 'swept', points: localPoints, localToSurface, radiusCss: query.radiusCss };
                let hit = false;
                if (prepared.ink) {
                    let uncertain = false, any = false, all = true;
                    for (const coverage of prepared.ink) {
                        const job = new InkRegionPickJob(coverage, localToSurface, localQuery, viewport.dpr);
                        try {
                            for (;;) {
                                check(); const state = job.step({ deadline: performance.now() + 3, maxVisits: 128 });
                                if (state.status === 'complete') {
                                    const decision = state.result!.decision; any ||= decision === 'hit'; all &&= decision === 'hit'; uncertain ||= decision === 'uncertain'; break;
                                }
                                await cooperate();
                            }
                        } finally { job.cancel(); }
                        if (query.kind === 'polygon' && query.containment ? !all && !uncertain : any) break;
                    }
                    const containment = query.kind === 'polygon' && query.containment;
                    hit = containment ? all && prepared.ink.length > 0 : any;
                    if (!hit && uncertain) throw new BoardRegionUncertain('Ink region intersection is numerically ambiguous');
                } else if (prepared.vector) {
                    let vector = prepared.vector;
                    const line = node.kind === 'polyline' ? node as typeof node & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null } : null;
                    if (line && (line.startAttach || line.endAttach)) {
                        const resolvedLine = await resolvePolylineAttachments(line, { runtime, doc, signal, cooperate,
                            current: () => { try { check(); return true; } catch { return false; } } });
                        try {
                            check(); vector = preparePolylineGeometry({ ...line, points: [...resolvedLine.points] }, { key: vector.key,
                                kernelVersion: 1, lengthError: 0.01, maxPieces: 8192, hitMarginCss: 4, hitErrorCss: 0.01 });
                        } finally { resolvedLine.release(); }
                    }
                    hit = vector.region(localQuery).hit;
                } else if (prepared.connector && node.kind === 'connector') {
                    const connector = prepared.connector, worldQuery = { ...localQuery, localToSurface: worldToCss } as RegionQuery;
                    const pathOptions = { strokeRadiusLocal: node.width / 2, marginCss: 0, errorCss: 0.01, maxSegments: 8192 };
                    const parts: boolean[] = [];
                    for (const head of connector.heads) {
                        parts.push(regionPath([head], worldQuery, { ...pathOptions,
                            ...(head[head.length - 1]?.op === 'Z' ? { interiorPaths: [head] } : {}) }).hit);
                    }
                    if (connector.label) {
                        const box = connector.label.paint.box, labelQuery = { ...localQuery, localToSurface: compose(worldToCss, connector.label.localToWorld) } as RegionQuery;
                        parts.push(regionPath([], labelQuery, { ...pathOptions, strokeRadiusLocal: 0, interiorPaths: [rectPath(0, 0, box.w, box.h)] }).hit);
                    }
                    const containment = query.kind === 'polygon' && query.containment;
                    if (!containment && parts.some(Boolean)) hit = true;
                    else {
                        if (node.dash !== 'none' && connector.body.length) {
                            const body = regionPath([connector.body], worldQuery, pathOptions).hit;
                            if (connector.bodyExclusions.length && (body || containment)) throw new BoardRegionUncertain('Connector body exclusions require clipped geometry');
                            parts.push(body);
                        }
                        hit = containment ? parts.length > 0 && parts.every(Boolean) : parts.some(Boolean);
                    }
                } else throw new BoardRegionUncertain(`No real region geometry for ${node.kind}`);
                check();
                if (hit) hits.set(selected, Math.max(hits.get(selected) ?? -Infinity, resolved.rank));
            };
            let done = false;
            while (!done || queue.length) {
                check();
                if (!queue.length && !done) {
                    const state = cursor.resume({ deadline: performance.now() + 3, maxVisits: 64 }, ref => queue.push(ref));
                    if (state === 'stale' || state === 'cancelled') throw stale();
                    done = state === 'complete';
                }
                const ref = queue.shift(); if (ref) await narrow(ref);
                if (!done || queue.length) { await cooperate(); check(); }
            }
            check();
            return Object.freeze([...hits].sort((a, b) => a[1] - b[1]).map(([id]) => id));
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) { try { options.onError(error); } catch { /* preserve query failure */ } }
            throw error;
        } finally { cursor?.cancel(); }
    }
    return { region };
}
