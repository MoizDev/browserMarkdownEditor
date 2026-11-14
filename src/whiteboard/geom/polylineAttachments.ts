import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Point } from '../model/nodes';
import type { AttachmentSurface } from './connectorTypes';
import { polylinePointSteps, POLYLINE_TOLERANCE_WORLD, type AttachedPolyline } from './polylinePoints';
import { attachedPolylineTargets, polylineSurface, polylineSurfaceClips, settlePolylineSteps } from './polylineResolve';

export interface PolylineAttachmentOptions {
    readonly runtime: BoardRuntime;
    readonly doc?: BoardDoc;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    readonly toleranceWorld?: number;
}
export interface ResolvedPolylineAttachments {
    readonly points: readonly Point[];
    readonly fontEpoch: number;
    release(): void;
}

/** Resolve both bindings against one staged document and the renderer's actual attachment surfaces. */
export async function resolvePolylineAttachments(node: AttachedPolyline, options: PolylineAttachmentOptions): Promise<ResolvedPolylineAttachments> {
    const { runtime } = options, session = runtime.session, live = session.doc, doc = options.doc ?? live;
    const revision = doc.rev, liveRevision = live.rev, owner = session.owner, signal = options.signal ?? new AbortController().signal;
    const tolerance = options.toleranceWorld ?? POLYLINE_TOLERANCE_WORLD;
    let released = false, epoch: number | undefined;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === live
        && live.rev === liveRevision && doc.rev === revision && (epoch === undefined || runtime.render.text.fonts.epoch === epoch);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Polyline attachment source changed', 'AbortError'); };
    if (!Number.isFinite(tolerance) || tolerance <= 0 || node.points.length < 2 || doc.nodes.get(node.id) !== node) throw new RangeError('Invalid attached polyline');
    check();
    const targets = attachedPolylineTargets(node);
    const scope = await acquireBoardGeometryScope(runtime, [node.id, ...targets], { doc, signal, current, cooperate: options.cooperate });
    try {
        check(); epoch = runtime.render.text.fonts.epoch;
        const surfaces = new Map<NodeId, AttachmentSurface>();
        for (const id of targets) {
            const target = doc.nodes.get(id); if (!target) throw new Error(`Missing polyline attachment target: ${id}`);
            const geometry = await runtime.render.prepareForPick(target, signal, doc); check();
            const surface = geometry.vector?.attachments;
            if (!surface) throw new Error(`Polyline attachment target has no supported surface: ${id}`);
            surfaces.set(id, polylineSurface(doc, target, surface, revision, polylineSurfaceClips(doc, target)));
        }
        const points = await settlePolylineSteps(polylinePointSteps(node, doc, surfaces, tolerance, check), signal, options.cooperate);
        check();
        return { points, fontEpoch: epoch, release() { if (!released) { released = true; scope.release(); } } };
    } catch (error) { scope.release(); throw error; }
}
