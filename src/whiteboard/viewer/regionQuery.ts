import type { Affine, ViewState } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { isCancellation } from '../../platform/workers/envelope';
import { worldPose } from '../change/coordinates';
import { compose, inverse } from '../geom/affine';
import type { PathPickOptions } from '../geom/pick';
import { createSweptPathJob } from '../geom/sweptPathJob';
import { createClippedSweptPathJob } from '../geom/clippedSweptPathJob';
import { createClippedPolygonPathJob } from '../geom/clippedPolygonPathJob';
import { createClippedFilledSweepJob } from '../geom/clippedFilledSweepJob';
import { createClippedFilledPolygonJob } from '../geom/clippedFilledPolygonJob';
import type { PointClipContour } from '../geom/clippedPointPathJob';
import { createPolygonPathJob } from '../geom/polygonPathJob';
import { resolvePolylineAttachments } from '../geom/polylineAttachments';
import { preparePolylineGeometry } from '../geom/providers';
import { createVectorRegionJob, vectorNarrowDescriptor, type VectorNarrowDescriptor } from '../geom/vectorNarrow';
import { createClippedVectorRegionJob } from '../geom/clippedVectorRegionJob';
import { orient2d } from '../geom/predicates';
import { boardFrameAncestors } from '../geom/ancestorFrames';
import { createPolygonTriangulationJob } from '../geom/polygonTriangulation';
import { createNonconvexContainmentJob } from '../geom/nonconvexContainmentJob';
import { createClippedInkRegionJob } from '../geom/clippedInkJobs';
import { exactAffinePoint } from '../geom/exactAffine';
import { exactIntersection, exactLineBetween, exactPoint, exactPointIntervals, exactSide, type ExactPoint } from '../geom/homogeneous';
import type { PathOp, Vec2 } from '../geom/path';
import type { RegionQuery } from '../geom/types';
import type { BoardRuntime } from '../host/runtime';
import { InkRegionPickJob } from '../ink/regionPick';
import type { NodeId } from '../model/ids';
import type { Attachment, FigureNode, Node } from '../model/nodes';
import type { SpatialRef } from '../pick';
import { BoundsQuality } from '../scene/bounds';
import type { createBoardRenderServices } from '../render/services';
import { selectableAtFocus } from '../selection';
import { yieldToHost } from '../../platform/yieldToHost';

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
// The mapping is what a query depends on. The view epoch also ticks for a motion flag with an unchanged
// camera (seen when an Eraser drag ends), which made every erase sweep throw "stale".
function stampView(a: ViewState, b: ViewState): boolean {
    return a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
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
const yieldToTask = yieldToHost;
/** A figure's narrow parts for a query that touches only what is painted: with no fill, its body is its outline alone. A
 * dashed or dotted outline is touched along its whole line (its gaps are narrower than an eraser, and a sweep that happened
 * to cross in one missed). A figure that paints neither fill nor outline keeps its inside: nothing else of it can be touched. */
function paintedFigure(node: Readonly<FigureNode>, vector: { readonly attachments?: unknown }, descriptor: VectorNarrowDescriptor | undefined): VectorNarrowDescriptor | undefined {
    if (!descriptor || node.fill !== 'none' || node.dash === 'none') return descriptor;
    const outline = (vector.attachments as { readonly outline?: readonly PathOp[] } | undefined)?.outline;
    return { parts: descriptor.parts.map(part => part.part !== 'body' ? part : { ...part,
        paths: (node.dash === 'dashed' || node.dash === 'dotted') && outline ? [outline] : part.paths,
        options: { ...part.options, interiorPaths: [] } }) };
}

export function createBoardRegionQuery(options: BoardRegionQueryOptions) {
    const { runtime } = options;
    // Each slice of the certified containment works for at most ~3 ms, then yields. setTimeout(0) is clamped to 4 ms
    // once nested, so most of the wall time was idle and a marquee around two shapes needed about a second; a press
    // in that second cancelled it (measured: no selection, the shapes moved one at a time). A message yield is not clamped.
    const cooperate = options.cooperate ?? yieldToTask;
    /** `at`: the view the query's points were mapped through. Given, the answer is of that view and stands wherever the
     * live view has gone by the time it is known (an eraser's path is kept in world units, so it loses nothing); absent,
     * the query reads the live view and is stale once that moves (a marquee is drawn on the screen).
     *
     * `painted`: only what an item paints counts. A figure with no fill is then touched through its outline and its label,
     * not through its empty inside, as a selecting query touches it: an eraser taken to a word written inside a drawn box
     * removed the box with it. */
    async function region(query: RegionQuery, signal: AbortSignal, how?: { readonly at?: ViewState; readonly painted?: boolean }): Promise<readonly NodeId[]> {
        const at = how?.at, painted = how?.painted === true;
        let cursor: ReturnType<NonNullable<typeof runtime.scene>['spatialCursor']> | undefined;
        try {
            signal.throwIfAborted();
            const doc = runtime.session.doc, scene = runtime.scene;
            if (!scene) throw new BoardRegionUncertain('Board scene is not ready');
            // A sweep that starts while the scene still absorbs the previous commit waits for it, as a point query does.
            // It threw before, and the eraser's next drag right after an erase lost every hit with a notice.
            while (!scene.ready) {
                scene.step(32, performance.now() + 3); await cooperate(); signal.throwIfAborted();
                if (runtime.scene !== scene || runtime.session.doc !== doc) throw stale();
            }
            const pin = scene.pin(); let token: RenderToken;
            try { token = Object.freeze({ ...pin.token }); } finally { pin.release(); }
            const view = at ?? options.camera(), camera = Object.freeze({ ...view.camera }), viewport = Object.freeze({ ...view.viewport });
            const viewStamp: ViewState = { ...view, camera, viewport }, revision = doc.rev, font = options.fontEpoch();
            const selection = runtime.selection.getSnapshot(), { sheet, focus } = selection;
            const check = () => {
                signal.throwIfAborted();
                const next = runtime.selection.getSnapshot();
                if (!options.current(token) || runtime.scene !== scene || !scene.ready || scene.revision !== revision || doc.rev !== revision
                    || options.fontEpoch() !== font || (!at && !stampView(viewStamp, options.camera())) || next.sheet !== sheet || next.focus !== focus) throw stale();
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
            let regions: readonly (readonly Vec2[])[] = [points], decomposedContainment = false;
            if (query.kind === 'polygon' && points.length > 3) {
                const triangulation = createPolygonTriangulationJob(points);
                try {
                    for (;;) {
                        const value = triangulation.step({ deadline: performance.now() + 3, maxWork: 128 });
                        if (value.status === 'pending') { await cooperate(); check(); continue; }
                        // A polygon that cannot be triangulated (a box dragged exactly along one axis has no area) is queried whole:
                        // the narrow jobs take it as it is, winding and boundary included.
                        if (value.status === 'uncertain') break;
                        let convex = points.length <= 64, winding = 0;
                        for (let i = 0; i < points.length; i++) {
                            const side = orient2d(points[i], points[(i + 1) % points.length], points[(i + 2) % points.length]);
                            if (!side || (winding && winding !== side)) convex = false;
                            if (side) winding = side;
                            if ((i & 255) === 255) { await cooperate(); check(); }
                        }
                        if (!query.containment || !convex) { regions = value.triangles; decomposedContainment = query.containment; }
                        break;
                    }
                } finally { triangulation.cancel(); }
            }
            const margin = query.kind === 'swept' ? query.radiusCss : 0;
            const worldBox: [number, number, number, number] = [camera.x + (minX - margin) / camera.z, camera.y + (minY - margin) / camera.z,
                camera.x + (maxX + margin) / camera.z, camera.y + (maxY + margin) / camera.z];
            if (!worldBox.every(Number.isFinite)) throw new RangeError('Board region bounds overflow');
            const worldToCss: Affine = [camera.z, 0, 0, camera.z, -camera.x * camera.z, -camera.y * camera.z];
            const queue: SpatialRef[] = [], hits = new Map<NodeId, number>();
            const groups = new Map<NodeId, number>(), evaluated = new Map<NodeId, { readonly selected: NodeId; readonly hit: boolean; readonly rank: number; readonly whole?: boolean; readonly empty?: boolean }>();
            cursor = scene.spatialCursor({ sheetId: sheet, purpose: 'selectable', request: { kind: 'box', box: worldBox, order: 'forward' } });
            const narrowPart = async (ref: SpatialRef, regionPoints: readonly Vec2[]) => {
                check();
                const resolved = scene.resolveSpatial(ref);
                if (!resolved) throw stale();
                const node = doc.nodes.get(resolved.id);
                if (!node) throw stale();
                if (node.kind === 'group') return undefined;
                const selected = selectableAtFocus(doc, node.id, focus, sheet);
                if (!selected) return undefined;
                if (query.kind === 'polygon' && query.containment && selected !== node.id)
                    groups.set(selected, Math.max(groups.get(selected) ?? -Infinity, resolved.rank));
                const prepared = await options.geometry.prepareForPick(node, signal, undefined, camera.z); check();
                const hasCertifiedVector = !!prepared.vector && !!vectorNarrowDescriptor(prepared.vector);
                let localPoints: readonly Vec2[] = regionPoints, partialFrame = false;
                const frameClips: PointClipContour[] = [];
                for (const ancestor of boardFrameAncestors(doc, node)) {
                        const frameWorld = matrix(doc, ancestor.id), toFrame = inverse(frameWorld, 1e12), record = scene.worldBounds(node.id);
                        frameClips.push({ outline: rectPath(0, 0, ancestor.w, ancestor.h), localToSurface: compose(worldToCss, frameWorld) });
                        const bounds = record && (record.quality === BoundsQuality.Exact || record.quality === BoundsQuality.Conservative)
                            ? record.selectable : null;
                        if (!toFrame || !bounds) throw new BoardRegionUncertain('Frame-clipped selection has no certified bounds');
                        const corners = [{ x: bounds[0], y: bounds[1] }, { x: bounds[2], y: bounds[1] },
                            { x: bounds[2], y: bounds[3] }, { x: bounds[0], y: bounds[3] }].map(p => exactPointIntervals(exactAffinePoint(toFrame, p)));
                        const frame = ancestor;
                        const fullyVisible = corners.every(p => p.x.lo > 0 && p.y.lo > 0 && p.x.hi < frame.w && p.y.hi < frame.h);
                        if (!fullyVisible) {
                            if (node.kind === 'connector' || node.kind === 'figure' || hasCertifiedVector || prepared.ink) partialFrame = true;
                            else {
                                if (query.kind === 'swept' || query.containment) throw new BoardRegionUncertain('Frame-clipped region needs visible-extent certification');
                                const frameCss = compose(worldToCss, frameWorld), polygon = [{ x: 0, y: 0 }, { x: ancestor.w, y: 0 },
                                    { x: ancestor.w, y: ancestor.h }, { x: 0, y: ancestor.h }].map(p => exactAffinePoint(frameCss, p));
                                localPoints = clipPolygon(localPoints, polygon);
                                if (!localPoints.length) {
                                    return { selected, hit: false, rank: resolved.rank, whole: false, empty: false };
                                }
                                if (localPoints.length < 3) throw new BoardRegionUncertain('Frame-clipped polygon has a degenerate intersection');
                            }
                        }
                }
                const localToSurface = compose(worldToCss, ref.localToWorld);
                const localQuery: RegionQuery = query.kind === 'polygon'
                    ? { kind: 'polygon', points: localPoints, localToSurface, containment: query.containment }
                    : { kind: 'swept', points: localPoints, localToSurface, radiusCss: query.radiusCss };
                let hit = false, whole = false, empty = false;
                if (prepared.ink) {
                    // An ink answer with no witness either way is a tangency within the coverage error (a fraction of a device
                    // pixel, INK_PICK_TOLERANCE_DEVICE_PX plus the outline's certified error): the eraser or lasso edge touches
                    // the painted edge. It is decided here, per stroke, rather than failing the query: touching counts as a hit for
                    // an eraser, a lasso or a box that selects what it touches, and as "not inside" for a containment box. It
                    // rejected the whole query before: one stroke tangent to an eraser sample discarded every other stroke the drag
                    // had clearly crossed, behind the notice "Ink region intersection is numerically ambiguous".
                    const runInk = async (region: RegionQuery): Promise<{ hit: boolean; empty: boolean }> => {
                        let any = false, all = true, visible = false;
                        const containment = region.kind === 'polygon' && region.containment;
                        for (const coverage of prepared.ink!) {
                            if (!coverage.segments.length && !coverage.discs.length) continue;
                            if (partialFrame) {
                                const job = createClippedInkRegionJob(coverage, localToSurface, region, viewport.dpr, frameClips);
                                try {
                                    for (;;) {
                                        check(); const state = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                        if (state.status === 'pending') { await cooperate(); continue; }
                                        if (state.status !== 'empty') visible = true;
                                        any ||= state.status === 'hit' || state.status === 'uncertain'; all &&= state.status === 'hit' || state.status === 'empty';
                                        break;
                                    }
                                } finally { job.cancel(); }
                            } else {
                                const job = new InkRegionPickJob(coverage, localToSurface, region, viewport.dpr);
                                try {
                                    for (;;) {
                                        check(); const state = job.step({ deadline: performance.now() + 3, maxVisits: 128 });
                                        if (state.status === 'complete') {
                                            const decision = state.result!.decision; visible = true; any ||= decision !== 'miss'; all &&= decision === 'hit'; break;
                                        }
                                        await cooperate();
                                    }
                                } finally { job.cancel(); }
                            }
                            if (containment ? !all : any) break;
                        }
                        return { hit: containment ? all && visible : any, empty: containment && !visible };
                    };
                    if (decomposedContainment && query.kind === 'polygon') {
                        const full = await runInk({ ...query, points, localToSurface });
                        whole = true; hit = full.hit; empty = full.empty;
                    } else {
                        const part = await runInk(localQuery); hit = part.hit; empty = part.empty;
                    }
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
                    void vector.key;
                    const descriptor = painted && node.kind === 'figure' ? paintedFigure(node, vector, vectorNarrowDescriptor(vector)) : vectorNarrowDescriptor(vector);
                    if (descriptor) {
                        if (decomposedContainment && query.kind === 'polygon') {
                            const job = createNonconvexContainmentJob(descriptor, { ...query, points, localToSurface }, { frames: partialFrame ? frameClips : [] });
                            try {
                                for (;;) {
                                    check(); const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                    if (value.status === 'pending') { await cooperate(); continue; }
                                    if (value.status !== 'uncertain') { whole = true; hit = value.status === 'hit'; empty = value.status === 'empty'; }
                                    break;
                                }
                            } finally { job.cancel(); }
                        }
                        if (!whole) {
                            const job = partialFrame ? createClippedVectorRegionJob(descriptor, localQuery, frameClips) : createVectorRegionJob(descriptor, localQuery);
                            try {
                                for (;;) {
                                    check(); const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                    if (value.status === 'pending') { await cooperate(); continue; }
                                    if (value.status === 'uncertain') throw new BoardRegionUncertain(value.reason);
                                    hit = value.status === 'hit'; empty = value.status === 'empty'; break;
                                }
                            } finally { job.cancel(); }
                        }
                    } else {
                        if (partialFrame) throw new BoardRegionUncertain('Clipped vector has no certified narrow descriptor');
                        hit = vector.region(localQuery).hit;
                    }
                } else if (prepared.connector && node.kind === 'connector') {
                    const connector = prepared.connector, worldQuery = { ...localQuery, localToSurface: worldToCss } as RegionQuery;
                    const pathOptions = { strokeRadiusLocal: node.width / 2, marginCss: 0, errorCss: 0.01, maxSegments: 8192 };
                    if (decomposedContainment && !partialFrame && !connector.bodyExclusions.length && query.kind === 'polygon') {
                        const components: { path: readonly PathOp[]; transform: Affine; fill: boolean; radius: number; part: 'head' | 'label' | 'body' }[] = [];
                        for (const path of connector.heads) components.push({ path, transform: worldToCss, fill: path.at(-1)?.op === 'Z', radius: node.width / 2, part: 'head' });
                        if (connector.label) {
                            const box = connector.label.paint.box;
                            components.push({ path: rectPath(0, 0, box.w, box.h), transform: compose(worldToCss, connector.label.localToWorld), fill: true, radius: 0, part: 'label' });
                        }
                        if (node.dash !== 'none' && connector.body.length)
                            components.push({ path: connector.body, transform: worldToCss, fill: false, radius: node.width / 2, part: 'body' });
                        let certified = components.length > 0, all = true, componentSeen = false;
                        for (const component of components) {
                            const options = { ...pathOptions, strokeRadiusLocal: component.radius,
                                ...(component.fill ? { interiorPaths: [component.path] } : {}) };
                            const descriptor = { parts: [{ part: component.part, paths: [component.path], options }] };
                            const job = createNonconvexContainmentJob(descriptor, { ...query, points, localToSurface: component.transform });
                            try {
                                for (;;) {
                                    check(); const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                    if (value.status === 'pending') { await cooperate(); continue; }
                                    if (value.status === 'uncertain') certified = false;
                                    else if (value.status !== 'empty') { componentSeen = true; if (value.status === 'miss') all = false; }
                                    break;
                                }
                            } finally { job.cancel(); }
                            if (!certified || !all) break;
                        }
                        if (certified) return { selected, hit: all && componentSeen, rank: resolved.rank, whole: true, empty: !componentSeen };
                    }
                    const pathHit = async (paths: readonly (readonly PathOp[])[], region: RegionQuery, pathOptions: PathPickOptions) => {
                        const job = region.kind === 'swept' ? createSweptPathJob(paths, region, pathOptions)
                            : createPolygonPathJob(paths, region, pathOptions);
                        try {
                            for (;;) {
                                check(); const state = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                if (state.status === 'hit') return true;
                                if (state.status === 'miss') return false;
                                if (state.status === 'uncertain') throw new BoardRegionUncertain(state.reason);
                                await cooperate();
                            }
                        } finally { job.cancel(); }
                    };
                    const clippedPart = async (path: readonly PathOp[], region: Extract<RegionQuery, { kind: 'swept' }>, fill: boolean, strokeRadiusLocal: number) => {
                        const job = createClippedFilledSweepJob(path, region, { frames: frameClips, fill, strokeRadiusLocal });
                        try {
                            for (;;) {
                                check(); const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                if (value.status === 'pending') { await cooperate(); continue; }
                                if (value.status === 'uncertain') throw new BoardRegionUncertain(value.reason);
                                return value.status === 'hit';
                            }
                        } finally { job.cancel(); }
                    };
                    const clippedPolygonPart = async (path: readonly PathOp[], region: Extract<RegionQuery, { kind: 'polygon' }>, fill: boolean, strokeRadiusLocal: number): Promise<boolean | null> => {
                        const job = createClippedFilledPolygonJob(path, region, { frames: frameClips, fill, strokeRadiusLocal });
                        try {
                            for (;;) {
                                check(); const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                if (value.status === 'pending') { await cooperate(); continue; }
                                if (value.status === 'uncertain') throw new BoardRegionUncertain(value.reason);
                                return value.status === 'empty' ? null : value.status === 'hit';
                            }
                        } finally { job.cancel(); }
                    };
                    const parts: boolean[] = [];
                    for (const head of connector.heads) {
                        const closed = head[head.length - 1]?.op === 'Z';
                        const part = partialFrame ? (worldQuery.kind === 'swept' ? await clippedPart(head, worldQuery, closed, node.width / 2)
                            : await clippedPolygonPart(head, worldQuery, closed, node.width / 2))
                            : await pathHit([head], worldQuery, { ...pathOptions, ...(closed ? { interiorPaths: [head] } : {}) });
                        if (part !== null) parts.push(part);
                    }
                    if (connector.label) {
                        const box = connector.label.paint.box, labelQuery = { ...localQuery, localToSurface: compose(worldToCss, connector.label.localToWorld) } as RegionQuery;
                        const labelPath = rectPath(0, 0, box.w, box.h);
                        const part = partialFrame ? (labelQuery.kind === 'swept' ? await clippedPart(labelPath, labelQuery, true, 0)
                            : await clippedPolygonPart(labelPath, labelQuery, true, 0))
                            : await pathHit([], labelQuery, { ...pathOptions, strokeRadiusLocal: 0, interiorPaths: [labelPath] });
                        if (part !== null) parts.push(part);
                    }
                    const containment = query.kind === 'polygon' && query.containment, otherHit = parts.some(Boolean);
                    const partsCertified = partialFrame;
                    if (!containment && otherHit && (!partialFrame || partsCertified)) hit = true;
                    else {
                        let body = false, bodyExists = true;
                        if (node.dash !== 'none' && connector.body.length) {
                            if (worldQuery.kind === 'swept' && (frameClips.length || connector.bodyExclusions.length)) {
                                const exclusions = connector.bodyExclusions.map(clip => ({ outline: clip.outline, localToSurface: compose(worldToCss, clip.localToWorld) }));
                                const job = createClippedSweptPathJob([connector.body], worldQuery, { strokeRadiusLocal: node.width / 2, frames: frameClips, exclusions });
                                try {
                                    for (;;) {
                                        check(); const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                        if (value.status === 'pending') { await cooperate(); continue; }
                                        if (value.status === 'uncertain') throw new BoardRegionUncertain(value.reason);
                                        body = value.status === 'hit'; break;
                                    }
                                } finally { job.cancel(); }
                            } else if (worldQuery.kind === 'polygon' && (frameClips.length || connector.bodyExclusions.length)) {
                                const exclusions = connector.bodyExclusions.map(clip => ({ outline: clip.outline, localToSurface: compose(worldToCss, clip.localToWorld) }));
                                const job = createClippedPolygonPathJob([connector.body], worldQuery, { strokeRadiusLocal: node.width / 2, frames: frameClips, exclusions });
                                try {
                                    for (;;) {
                                        check(); const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                        if (value.status === 'pending') { await cooperate(); continue; }
                                        if (value.status === 'uncertain') throw new BoardRegionUncertain(value.reason);
                                        bodyExists = value.status !== 'empty'; body = value.status === 'hit'; break;
                                    }
                                } finally { job.cancel(); }
                            } else body = await pathHit([connector.body], worldQuery, pathOptions);
                            if (bodyExists) parts.push(body);
                        }
                        if (!containment && !body && otherHit && partialFrame && !partsCertified) throw new BoardRegionUncertain('Frame-clipped connector head requires a visible witness');
                        hit = containment ? parts.length > 0 && parts.every(Boolean) : body || ((!partialFrame || partsCertified) && otherHit);
                        empty = containment && partialFrame && parts.length === 0;
                    }
                } else throw new BoardRegionUncertain(`No real region geometry for ${node.kind}`);
                check();
                return { selected, hit, rank: resolved.rank, whole, empty };
            };
            const narrow = async (ref: SpatialRef) => {
                check(); const resolved = scene.resolveSpatial(ref); if (!resolved) throw stale();
                const cached = evaluated.get(resolved.id); if (cached) return cached;
                let result: Awaited<ReturnType<typeof narrowPart>> = undefined, uncertain: BoardRegionUncertain | undefined;
                for (const regionPoints of regions) {
                    try {
                        result = await narrowPart(ref, regionPoints);
                        if (!result || result.hit || result.whole || result.empty) break;
                    } catch (error) {
                        if (!(error instanceof BoardRegionUncertain)) throw error;
                        uncertain ??= error;
                    }
                    await cooperate(); check();
                }
                // A node whose geometry cannot be decided (a frame clip without a certified extent, a vector at its exact edge, a
                // containment that spans two pieces of a non-convex lasso) is a miss for this one node: it stays, the person can
                // sweep it again, and every node that WAS decided keeps its answer. One such node rejected the whole query before,
                // and the eraser or marquee lost everything it had found, behind a notice in geometry jargon.
                if (!result?.hit && !result?.whole && !result?.empty && uncertain) {
                    const selected = selectableAtFocus(doc, resolved.id, focus, sheet);
                    result = selected ? { selected, hit: false, rank: resolved.rank, whole: false, empty: false } : undefined;
                }
                if (result) {
                    evaluated.set(resolved.id, result);
                    if (result.hit && !(query.kind === 'polygon' && query.containment && result.selected !== resolved.id))
                        hits.set(result.selected, Math.max(hits.get(result.selected) ?? -Infinity, result.rank));
                }
                return result;
            };
            let done = false, queueIndex = 0;
            while (!done || queueIndex < queue.length) {
                check();
                if (queueIndex === queue.length && !done) {
                    queue.length = 0; queueIndex = 0;
                    const state = cursor.resume({ deadline: performance.now() + 3, maxVisits: 64 }, ref => queue.push(ref));
                    if (state === 'stale' || state === 'cancelled') throw stale();
                    done = state === 'complete';
                }
                const ref = queueIndex < queue.length ? queue[queueIndex++] : undefined; if (ref) await narrow(ref);
                if (!done || queueIndex < queue.length) { await cooperate(); check(); }
            }
            if (query.kind === 'polygon' && query.containment && groups.size) {
                const states = new Map<NodeId, { all: boolean; any: boolean; rank: number }>();
                let slice = 0;
                for (const [group, rank] of groups) {
                    states.set(group, { all: true, any: false, rank });
                    if (++slice >= 256) { slice = 0; await cooperate(); check(); }
                }
                for (const result of evaluated.values()) {
                    const state = states.get(result.selected);
                    if (state && !result.empty) { state.any = true; state.all &&= result.hit; state.rank = Math.max(state.rank, result.rank); }
                    if (++slice >= 256) { slice = 0; await cooperate(); check(); }
                }
                let aggregate: [number, number, number, number] | undefined;
                for (const [group, state] of states) {
                    if (state.all) {
                        check(); const record = scene.worldBounds(group), bounds = record && (record.quality === BoundsQuality.Exact || record.quality === BoundsQuality.Conservative)
                            ? record.selectable : null;
                        if (!bounds || !bounds.every(Number.isFinite)) throw new BoardRegionUncertain('Group containment has no certified aggregate bounds');
                        aggregate = aggregate ? [Math.min(aggregate[0], bounds[0]), Math.min(aggregate[1], bounds[1]),
                            Math.max(aggregate[2], bounds[2]), Math.max(aggregate[3], bounds[3])] : [bounds[0], bounds[1], bounds[2], bounds[3]];
                    }
                    if (++slice >= 256) { slice = 0; await cooperate(); check(); }
                }
                if (aggregate) {
                    const members = scene.spatialCursor({ sheetId: sheet, purpose: 'selectable', request: { kind: 'box', box: aggregate, order: 'forward' } });
                    let complete = false, pendingIndex = 0; const pending: SpatialRef[] = [];
                    try {
                        while (!complete || pendingIndex < pending.length) {
                            check();
                            if (pendingIndex === pending.length && !complete) {
                                pending.length = 0; pendingIndex = 0;
                                const state = members.resume({ deadline: performance.now() + 3, maxVisits: 64 }, ref => pending.push(ref));
                                if (state === 'stale' || state === 'cancelled') throw stale();
                                complete = state === 'complete';
                            }
                            const ref = pendingIndex < pending.length ? pending[pendingIndex++] : undefined;
                            if (ref) {
                                const member = scene.resolveSpatial(ref); if (!member) throw stale();
                                const selected = selectableAtFocus(doc, member.id, focus, sheet), state = selected ? states.get(selected) : undefined;
                                if (state?.all) {
                                    const result = await narrow(ref);
                                    if (result && !result.empty) { state.any = true; state.all &&= result.hit; state.rank = Math.max(state.rank, result.rank); }
                                }
                            }
                            if (!complete || pendingIndex < pending.length) { await cooperate(); check(); }
                        }
                    } finally { members.cancel(); }
                }
                for (const [group, state] of states) {
                    if (state.any && state.all) hits.set(group, state.rank);
                    if (++slice >= 256) { slice = 0; await cooperate(); check(); }
                }
            }
            check();
            let ordered: [NodeId, number][] = [], buffer: [NodeId, number][] = [], work = 0, started = performance.now();
            const yieldSort = async () => { await cooperate(); check(); work = 0; started = performance.now(); };
            const due = () => ++work >= 256 || performance.now() - started >= 3;
            for (const entry of hits) { ordered.push(entry); if (due()) await yieldSort(); }
            buffer = new Array(ordered.length);
            for (let width = 1; width < ordered.length; width *= 2) {
                for (let start = 0; start < ordered.length; start += width * 2) {
                    const middle = Math.min(start + width, ordered.length), end = Math.min(start + width * 2, ordered.length);
                    let left = start, right = middle;
                    for (let i = start; i < end; i++) {
                        buffer[i] = left < middle && (right >= end || ordered[left][1] <= ordered[right][1]) ? ordered[left++] : ordered[right++];
                        if (due()) await yieldSort();
                    }
                }
                [ordered, buffer] = [buffer, ordered];
            }
            const result: NodeId[] = [];
            for (const [id] of ordered) { result.push(id); if (due()) await yieldSort(); }
            check(); return Object.freeze(result);
        } catch (error) {
            // A marquee the person ended (Escape, ⌘Z, a click) aborts its own signal: never theirs to see (isCancellation).
            if (!isCancellation(error) && !signal.aborted) { try { options.onError(error); } catch { /* preserve query failure */ } }
            throw error;
        } finally { cursor?.cancel(); }
    }
    return { region };
}
