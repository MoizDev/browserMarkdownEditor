import type { Affine, Rect, ViewState } from '../../platform/types';
import { cameraTransform, worldToSurface } from '../../platform/render/camera';
import { worldToLocal } from '../change/coordinates';
import { compose } from '../geom/affine';
import type { ConnectorGeometry } from '../geom/connectorTypes';
import type { PathOp, Vec2 } from '../geom/path';
import { pointPath } from '../geom/pick';
import { resolvePolylineAttachments } from '../geom/polylineAttachments';
import { preparePolylineGeometry } from '../geom/providers';
import type { InputKind, NarrowResult, PointQuery } from '../geom/types';
import type { BoardRuntime } from '../host/runtime';
import type { InkCoverage } from '../ink/outline';
import { InkPickJob } from '../ink/pick';
import type { NodeId } from '../model/ids';
import type { Attachment, Node, ConnectorNode } from '../model/nodes';
import type { SpatialRef } from '../pick';
import type { BoardVectorGeometry } from '../render/vectorGeometry';
import { selectableAtFocus } from '../selection';

export interface BoardPointQueryOptions {
    readonly runtime: BoardRuntime;
    readonly geometry: { prepareForPick(node: Readonly<Node>, signal: AbortSignal): Promise<Readonly<{
        vector?: BoardVectorGeometry; ink?: readonly InkCoverage[]; connector?: ConnectorGeometry;
    }>> };
    readonly camera: () => ViewState;
    readonly fontEpoch: () => number;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
    readonly onError: (error: unknown) => void;
}
export interface BoardTargetHit { readonly id: NodeId; readonly localToWorld: Affine; readonly logicalBox: Readonly<Rect> }
interface Candidate { readonly id: NodeId; readonly rank: number; readonly result: NarrowResult; readonly target?: BoardTargetHit }
const miss: NarrowResult = { hit: false, distanceCss: Infinity, part: 'none' };
const priority = (part: NarrowResult['part']): number => part === 'handle' ? 3 : part === 'label' || part === 'title' ? 2 : 0;
const better = (a: Candidate, b: Candidate) => priority(a.result.part) > priority(b.result.part)
    || (priority(a.result.part) === priority(b.result.part) && a.rank > b.rank);
function cancelled(): DOMException { return new DOMException('Point query became stale', 'AbortError'); }
function rectPath(rect: { x: number; y: number; width: number; height: number }): readonly PathOp[] {
    return [{ op: 'M', p: { x: rect.x, y: rect.y } }, { op: 'L', p: { x: rect.x + rect.width, y: rect.y } },
        { op: 'L', p: { x: rect.x + rect.width, y: rect.y + rect.height } }, { op: 'L', p: { x: rect.x, y: rect.y + rect.height } }, { op: 'Z' }];
}
const interior = (path: readonly PathOp[], query: PointQuery) => pointPath([], query,
    { interiorPaths: [path], strokeRadiusLocal: 0, marginCss: 0, errorCss: 0.01, maxSegments: 8192 }).hit;
function connectorPoint(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, worldToSurface: Affine,
    point: Vec2, input: InputKind): { result: NarrowResult; uncertain: boolean } {
    if (geometry.label) {
        const query = { point, input, localToSurface: compose(worldToSurface, geometry.label.localToWorld) };
        if (interior(rectPath(geometry.label.paint.ink), query)) return { result: { hit: true, distanceCss: 0, part: 'label' }, uncertain: false };
    }
    const query: PointQuery = { point, input, localToSurface: worldToSurface };
    const options = { strokeRadiusLocal: node.width / 2, marginCss: 4, errorCss: 0.01, maxSegments: 8192 };
    for (const head of geometry.heads) {
        const closed = head.at(-1)?.op === 'Z';
        const hit = pointPath([head], query, { ...options, ...(closed ? { interiorPaths: [head] } : {}) });
        if (hit.hit) return { result: { ...hit, part: 'head' }, uncertain: false };
    }
    if (node.dash === 'none' || !geometry.body.length) return { result: miss, uncertain: false };
    const hit = pointPath([geometry.body], query, options);
    if (!hit.hit) return { result: miss, uncertain: false };
    let excluded = false, nearBoundary = false;
    for (const clip of geometry.bodyExclusions) {
        const local = { point, input, localToSurface: compose(worldToSurface, clip.localToWorld) };
        if (interior(clip.outline, local)) excluded = !excluded;
        const radius = (input === 'touch' ? 8 : 4) + node.width * Math.hypot(worldToSurface[0], worldToSurface[1]) / 2;
        if (pointPath([clip.outline], local, { strokeRadiusLocal: 0, marginCss: radius, errorCss: 0.01, maxSegments: 8192 }).hit) nearBoundary = true;
    }
    // Near an exclusion the uncut witness might be hidden. Only a point farther
    // than its full CSS hit radius from every boundary certifies the same hit.
    return excluded || nearBoundary ? { result: { ...hit, part: 'body' }, uncertain: true }
        : { result: { ...hit, part: 'body' }, uncertain: false };
}

/** Queries one published Scene revision, not a second index or live paint cache. */
export function createBoardPointQuery(options: BoardPointQueryOptions): {
    hit(point: Vec2, input: InputKind, signal: AbortSignal): Promise<NodeId | null>;
    hitTarget(point: Vec2, input: InputKind, signal: AbortSignal): Promise<BoardTargetHit | null>;
    dispose(): void;
} {
    const jobs = new Set<AbortController>();
    let disposed = false;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    async function run(point: Vec2, input: InputKind, signal: AbortSignal, targetMode: boolean): Promise<Candidate | null> {
            if (disposed) throw cancelled();
            if (![point.x, point.y].every(Number.isFinite) || !['mouse', 'pen', 'touch'].includes(input)) throw new RangeError('Invalid point query');
            const { runtime } = options, doc = runtime.session.doc, revision = doc.rev, selection = runtime.selection.getSnapshot();
            const view = options.camera(), font = options.fontEpoch(), token = runtime.session.owner;
            const camera = { ...view.camera }, viewport = { ...view.viewport }, epoch = view.epoch;
            const controller = new AbortController(); jobs.add(controller);
            const combined = AbortSignal.any([signal, controller.signal]);
            let cursor: ReturnType<NonNullable<typeof runtime.scene>['spatialCursor']> | undefined;
            const check = () => {
                combined.throwIfAborted();
                const now = options.camera(), state = runtime.selection.getSnapshot();
                if (disposed || !options.current() || runtime.session.doc !== doc || runtime.session.owner !== token || doc.rev !== revision
                    || options.fontEpoch() !== font || state.sheet !== selection.sheet || state.focus !== selection.focus
                    || now.epoch !== epoch || now.camera.x !== camera.x || now.camera.y !== camera.y || now.camera.z !== camera.z
                    || now.viewport.width !== viewport.width || now.viewport.height !== viewport.height || now.viewport.dpr !== viewport.dpr) throw cancelled();
            };
            const tick = async () => { check(); await cooperate(); check(); };
            try {
                check();
                if (!Number.isFinite(camera.z) || camera.z <= 0 || !Number.isFinite(viewport.dpr) || viewport.dpr <= 0) throw new RangeError('Invalid point-query camera');
                const scene = runtime.scene ?? await new Promise<Awaited<BoardRuntime['ready']>>((resolve, reject) => {
                    const abort = () => { cleanup(); reject(combined.reason ?? cancelled()); };
                    const cleanup = () => combined.removeEventListener('abort', abort);
                    combined.addEventListener('abort', abort, { once: true });
                    runtime.ready.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
                    if (combined.aborted) abort();
                });
                check();
                while (!scene.ready) { scene.step(32, performance.now() + 3); await tick(); }
                if (runtime.scene !== scene || scene.revision !== revision) throw cancelled();
                const matrix = cameraTransform(camera), surface = worldToSurface(point, camera);
                cursor = scene.spatialCursor({ sheetId: selection.sheet, purpose: 'selectable', includeLocked: targetMode,
                    request: { kind: 'point', x: point.x, y: point.y, maxDistance: 8 / camera.z } });
                const refs: SpatialRef[] = [];
                for (;;) {
                    check();
                    const status = cursor.resume({ maxVisits: 128, deadline: performance.now() + 3 }, ref => refs.push(ref));
                    if (status === 'complete') break;
                    if (status !== 'pending') throw cancelled();
                    await tick();
                }
                let winner: Candidate | null = null;
                const uncertain: Candidate[] = [];
                for (const ref of refs) {
                    check();
                    const resolved = scene.resolveSpatial(ref);
                    if (!resolved) throw cancelled();
                    const node = doc.nodes.get(resolved.id);
                    if (!node) throw cancelled();
                    if (targetMode && (node.kind === 'group' || node.kind === 'connector' || node.kind === 'opaque')) continue;
                    const selected = targetMode ? node.id : selectableAtFocus(doc, node.id, selection.focus, selection.sheet);
                    if (!selected || node.kind === 'group') continue;
                    let parent = doc.nodes.get(node.parent as NodeId), clipped = false, clipUncertain = false;
                    for (let depth = 0; parent && depth < 64; depth++) {
                        if (parent.kind === 'frame') {
                            const local = worldToLocal(doc, parent, point);
                            if (local.x < 0 || local.y < 0 || local.x > parent.w || local.y > parent.h) { clipped = true; break; }
                            // A halo witness near the clip edge can belong entirely to hidden geometry.
                            const halo = (input === 'touch' ? 8 : 4) + (node.kind === 'stroke' ? 4 : 0);
                            if (Math.min(local.x, local.y, parent.w - local.x, parent.h - local.y) * camera.z <= halo) clipUncertain = true;
                        }
                        parent = doc.nodes.get(parent.parent as NodeId);
                    }
                    if (clipped) continue;
                    const prepared = await options.geometry.prepareForPick(node, combined);
                    check();
                    if (!scene.ready || scene.resolveSpatial(ref)?.id !== resolved.id || scene.resolveSpatial(ref)?.rank !== resolved.rank) throw cancelled();
                    let result = miss, ambiguous = false, target: BoardTargetHit | undefined;
                    const localToSurface = compose(matrix, ref.localToWorld);
                    if (node.kind === 'stroke') {
                        if (!prepared.ink) throw new Error('Stroke picking geometry is unavailable');
                        let maybe = false;
                        for (const coverage of prepared.ink) {
                            const job = new InkPickJob(coverage, localToSurface,
                                { kind: 'point', x: surface.x, y: surface.y, pointer: input }, viewport.dpr);
                            try {
                                while (job.step(64) === 'pending') await tick();
                                check();
                                if (job.result.decision === 'hit') { result = { hit: true, distanceCss: 0, part: 'body' }; break; }
                                if (job.result.decision === 'uncertain') maybe = true;
                            } finally { job.cancel(); }
                        }
                        if (!result.hit && maybe) { result = { hit: true, distanceCss: 0, part: 'body' }; ambiguous = true; }
                        if (targetMode && result.hit) ambiguous = true;
                    } else if (node.kind === 'connector') {
                        if (!prepared.connector) throw new Error('Connector picking geometry is unavailable');
                        ({ result, uncertain: ambiguous } = connectorPoint(node, prepared.connector, matrix, surface, input));
                    } else {
                        if (!prepared.vector) throw new Error('Vector picking geometry is unavailable');
                        let vector = prepared.vector;
                        const line = node.kind === 'polyline' ? node as typeof node & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null } : null;
                        if (line && (line.startAttach || line.endAttach)) {
                            const resolvedLine = await resolvePolylineAttachments(line, { runtime, doc, signal: combined, cooperate,
                                current: () => { try { check(); return true; } catch { return false; } } });
                            try {
                                check(); vector = preparePolylineGeometry({ ...line, points: [...resolvedLine.points] }, { key: vector.key,
                                    kernelVersion: 1, lengthError: 0.01, maxPieces: 8192, hitMarginCss: 4, hitErrorCss: 0.01 });
                            } finally { resolvedLine.release(); }
                        }
                        const query = { point: surface, localToSurface, input };
                        const attachment = vector.attachments;
                        if (targetMode && attachment) {
                            // Attachment targeting is an edge query, unlike selection of a hollow interior.
                            result = pointPath([attachment.outline], query, { strokeRadiusLocal: 0,
                                marginCss: 4, errorCss: 0.01, maxSegments: 8192 });
                            if (result.hit) target = { id: node.id, localToWorld: ref.localToWorld, logicalBox: attachment.logicalBox };
                        } else {
                            result = vector.point(query);
                            if (targetMode && result.hit) ambiguous = true;
                        }
                    }
                    check();
                    if (result.hit) {
                        // A zero-distance vector witness is the pointer itself and survives every containing clip.
                        ambiguous ||= clipUncertain && (node.kind === 'stroke' || result.distanceCss !== 0);
                        const candidate = { id: selected, rank: resolved.rank, result, ...(target ? { target } : {}) };
                        if (ambiguous) uncertain.push(candidate);
                        else if (!winner || (targetMode ? candidate.rank > winner.rank : better(candidate, winner))) winner = candidate;
                    }
                    await tick();
                }
                check();
                if (!scene.ready || scene.revision !== revision) throw cancelled();
                for (let i = 0; i < uncertain.length; i++) {
                    if ((i & 127) === 0) await tick();
                    const candidate = uncertain[i];
                    if (!winner || (candidate.id !== winner.id && !(targetMode ? winner.rank > candidate.rank : better(winner, candidate)))) {
                        throw new Error('Point hit is geometrically uncertain');
                    }
                }
                check();
                if (!scene.ready || scene.revision !== revision) throw cancelled();
                return winner;
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                    try { options.onError(error); } catch { /* Preserve the query error. */ }
                }
                throw error;
            } finally { cursor?.cancel(); jobs.delete(controller); }
    }
    return {
        async hit(point, input, signal) { return (await run(point, input, signal, false))?.id ?? null; },
        async hitTarget(point, input, signal) {
            const result = await run(point, input, signal, true);
            if (result && !result.target) throw new Error('Attachment target surface is unavailable');
            return result?.target ?? null;
        },
        dispose() { if (!disposed) { disposed = true; for (const job of jobs) job.abort(cancelled()); jobs.clear(); } },
    };
}
