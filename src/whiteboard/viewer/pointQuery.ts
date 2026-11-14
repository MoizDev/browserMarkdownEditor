import type { Affine, Rect, ViewState } from '../../platform/types';
import { cameraTransform, worldToSurface } from '../../platform/render/camera';
import { worldPose, worldToLocal } from '../change/coordinates';
import { compose } from '../geom/affine';
import type { ConnectorGeometry } from '../geom/connectorTypes';
import type { PathOp, Vec2 } from '../geom/path';
import { createAttachmentPointJob } from '../geom/attachmentPointJob';
import { createClippedInkPointJob } from '../geom/clippedInkJobs';
import { createPointPathJob, type PointPathJobResult } from '../geom/pointPathJob';
import { createClippedPointPathJob, type PointClipContour } from '../geom/clippedPointPathJob';
import { createClippedFilledPointJob } from '../geom/clippedFilledPointJob';
import type { PathPickOptions } from '../geom/pick';
import { pointInTransformedFrame } from '../geom/frameContainment';
import { boardFrameAncestors } from '../geom/ancestorFrames';
import { resolvePolylineAttachments } from '../geom/polylineAttachments';
import { preparePolylineGeometry } from '../geom/providers';
import { createVectorPointJob, vectorNarrowDescriptor } from '../geom/vectorNarrow';
import { createClippedVectorPointJob } from '../geom/clippedVectorPointJob';
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
async function connectorPoint(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, worldToSurface: Affine,
    point: Vec2, input: InputKind, frames: readonly PointClipContour[], tick: () => Promise<void>): Promise<{ result: NarrowResult; uncertain: boolean }> {
    const run = async (paths: readonly (readonly PathOp[])[], query: PointQuery, options: PathPickOptions): Promise<PointPathJobResult> => {
        const job = createPointPathJob(paths, query, options);
        try {
            for (;;) {
                const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                if (value.status !== 'pending') return value;
                await tick();
            }
        } finally { job.cancel(); }
    };
    const base = { strokeRadiusLocal: 0, marginCss: 0, errorCss: 0.01, maxSegments: 8192 };
    const clippedPart = async (path: readonly PathOp[], query: PointQuery, fill: boolean, strokeRadiusLocal: number, marginCss: number) => {
        const job = createClippedFilledPointJob(path, query, { frames, fill, strokeRadiusLocal, marginCss });
        try {
            for (;;) {
                const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                if (value.status !== 'pending') return value;
                await tick();
            }
        } finally { job.cancel(); }
    };
    if (geometry.label) {
        const query = { point, input: 'mouse' as const, localToSurface: compose(worldToSurface, geometry.label.localToWorld) };
        const path = rectPath(geometry.label.paint.ink);
        const hit = frames.length ? await clippedPart(path, query, true, 0, 0) : await run([], query, { ...base, interiorPaths: [path] });
        if (hit.status === 'hit') return { result: { hit: true, distanceCss: hit.distanceCss, part: 'label' }, uncertain: false };
        if (hit.status === 'uncertain') return { result: { hit: true, distanceCss: 0, part: 'label' }, uncertain: true };
    }
    const query: PointQuery = { point, input, localToSurface: worldToSurface };
    const options = { ...base, strokeRadiusLocal: node.width / 2, marginCss: 4 };
    let uncertainHead = false;
    for (const head of geometry.heads) {
        const closed = head.at(-1)?.op === 'Z';
        const hit = frames.length ? await clippedPart(head, query, closed, node.width / 2, 4)
            : await run([head], query, { ...options, ...(closed ? { interiorPaths: [head] } : {}) });
        if (hit.status === 'hit') return { result: { hit: true, distanceCss: hit.distanceCss, part: 'head' }, uncertain: false };
        if (hit.status === 'uncertain') uncertainHead = true;
    }
    if (node.dash === 'none' || !geometry.body.length) return uncertainHead
        ? { result: { hit: true, distanceCss: 0, part: 'head' }, uncertain: true } : { result: miss, uncertain: false };
    const hit = await run([geometry.body], query, options);
    if (hit.status === 'miss') return uncertainHead
        ? { result: { hit: true, distanceCss: 0, part: 'head' }, uncertain: true } : { result: miss, uncertain: false };
    if (hit.status === 'uncertain') return { result: { hit: true, distanceCss: 0, part: 'body' }, uncertain: true };
    if (frames.length || geometry.bodyExclusions.length) {
        const exclusions = geometry.bodyExclusions.map(clip => ({ outline: clip.outline, localToSurface: compose(worldToSurface, clip.localToWorld) }));
        const job = createClippedPointPathJob([geometry.body], query, { strokeRadiusLocal: node.width / 2, marginCss: 4, frames, exclusions });
        try {
            for (;;) {
                const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                if (value.status === 'pending') { await tick(); continue; }
                if (value.status === 'hit') return { result: { hit: true, distanceCss: value.distanceCss, part: 'body' }, uncertain: false };
                if (value.status === 'miss') return uncertainHead
                    ? { result: { hit: true, distanceCss: 0, part: 'head' }, uncertain: true } : { result: miss, uncertain: false };
                return { result: { hit: true, distanceCss: hit.distanceCss, part: 'body' }, uncertain: true };
            }
        } finally { job.cancel(); }
    }
    return { result: { hit: true, distanceCss: hit.distanceCss, part: 'body' }, uncertain: false };
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
                    // The renderer does not yet resolve stroke/polyline attachment surfaces.
                    if (targetMode && (node.kind === 'group' || node.kind === 'connector' || node.kind === 'opaque'
                        || node.kind === 'stroke' || node.kind === 'polyline')) continue;
                    const selected = targetMode ? node.id : selectableAtFocus(doc, node.id, selection.focus, selection.sheet);
                    if (!selected || node.kind === 'group') continue;
                    let clipped = false, clipUncertain = false;
                    const frameClips: PointClipContour[] = [];
                    for (const parent of boardFrameAncestors(doc, node)) {
                        const pose = worldPose(doc, parent.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                        const frame: Affine = [c, s, -s, c, pose.x, pose.y];
                        frameClips.push({ outline: rectPath({ x: 0, y: 0, width: parent.w, height: parent.h }), localToSurface: compose(matrix, frame) });
                        if (!pointInTransformedFrame(point, { x: 0, y: 0, width: parent.w, height: parent.h }, frame)) {
                            if (targetMode) { clipped = true; break; }
                            clipUncertain = true;
                        }
                        const local = worldToLocal(doc, parent, point);
                        // A halo witness near the clip edge can belong entirely to hidden geometry.
                        const halo = (input === 'touch' ? 8 : 4) + (node.kind === 'stroke' ? 4 : 0);
                        if (Math.min(local.x, local.y, parent.w - local.x, parent.h - local.y) * camera.z <= halo) clipUncertain = true;
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
                            if (frameClips.length && clipUncertain) {
                                const job = createClippedInkPointJob(coverage, localToSurface,
                                    { kind: 'point', x: surface.x, y: surface.y, pointer: input }, viewport.dpr, frameClips);
                                try {
                                    for (;;) {
                                        const value = job.step({ deadline: performance.now() + 3, maxWork: 64 });
                                        if (value.status === 'pending') { await tick(); continue; }
                                        if (value.status === 'hit') { result = { hit: true, distanceCss: 0, part: 'body' }; clipUncertain = false; }
                                        else if (value.status === 'uncertain') maybe = true;
                                        break;
                                    }
                                } finally { job.cancel(); }
                            } else {
                                const job = new InkPickJob(coverage, localToSurface,
                                    { kind: 'point', x: surface.x, y: surface.y, pointer: input }, viewport.dpr);
                                try {
                                    while (job.step(64) === 'pending') await tick();
                                    check();
                                    if (job.result.decision === 'hit') result = { hit: true, distanceCss: 0, part: 'body' };
                                    else if (job.result.decision === 'uncertain') maybe = true;
                                } finally { job.cancel(); }
                            }
                            if (result.hit) break;
                        }
                        if (!result.hit && maybe) { result = { hit: true, distanceCss: 0, part: 'body' }; ambiguous = true; }
                        if (targetMode && result.hit) ambiguous = true;
                    } else if (node.kind === 'connector') {
                        if (!prepared.connector) throw new Error('Connector picking geometry is unavailable');
                        ({ result, uncertain: ambiguous } = await connectorPoint(node, prepared.connector, matrix, surface, input, frameClips, tick));
                        if (!ambiguous) clipUncertain = false;
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
                            // The boundary and interior attach; the exterior selection halo does not.
                            const job = createAttachmentPointJob(attachment.outline, query, { maxCommands: 8192 });
                            try {
                                for (;;) {
                                    const state = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                    if (state.status === 'pending') { await tick(); continue; }
                                    if (state.status !== 'miss') {
                                        result = { hit: true, distanceCss: 0, part: 'body' }; ambiguous = state.status === 'uncertain';
                                    }
                                    break;
                                }
                            } finally { job.cancel(); }
                            if (result.hit && !ambiguous) target = { id: node.id, localToWorld: ref.localToWorld, logicalBox: attachment.logicalBox };
                        } else {
                            void vector.key;
                            const descriptor = vectorNarrowDescriptor(vector);
                            if (descriptor) {
                                const job = frameClips.length ? createClippedVectorPointJob(descriptor, query, frameClips) : createVectorPointJob(descriptor, query);
                                try {
                                    for (;;) {
                                        const value = job.step({ deadline: performance.now() + 3, maxWork: 128 });
                                        if (value.status === 'pending') { await tick(); continue; }
                                        if (value.status === 'hit') { result = value.result; if (frameClips.length) clipUncertain = false; }
                                        else if (value.status === 'uncertain') { result = { hit: true, distanceCss: 0, part: value.part }; ambiguous = true; }
                                        break;
                                    }
                                } finally { job.cancel(); }
                            } else result = vector.point(query);
                            if (targetMode && result.hit) ambiguous = true;
                        }
                    }
                    check();
                    if (result.hit) {
                        // A zero-distance vector witness is the pointer itself and survives every containing clip.
                        ambiguous ||= !targetMode && clipUncertain && (node.kind === 'stroke' || result.distanceCss !== 0);
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
