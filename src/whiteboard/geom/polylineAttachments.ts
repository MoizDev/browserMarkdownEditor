import type { Affine } from '../../platform/types';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Attachment, Node, Point, PolylineNode } from '../model/nodes';
import type { AttachmentSurface } from './connectorTypes';
import type { PathOp } from './path';
import { preparePolylineGeometry } from './providers';
import { prepareBoardAttachmentSurface } from '../render/attachmentSurfaces';
import { boardFrameAncestors } from './ancestorFrames';
import { polylineMatrix, polylinePointSteps, POLYLINE_TOLERANCE_WORLD, type AttachedPolyline } from './polylinePoints';
import { yieldToHost } from '../../platform/yieldToHost';

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
function rectangle(w: number, h: number): readonly PathOp[] {
    if (![w, h].every(Number.isFinite) || w < 0 || h < 0) throw new RangeError('Polyline attachment frame is invalid');
    return [{ op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' }];
}
export function polylineSurfaceClips(doc: BoardDoc, node: Readonly<Node>): AttachmentSurface['clips'] {
    const result: AttachmentSurface['clips'][number][] = [];
    for (const ancestor of boardFrameAncestors(doc, node))
        result.push({ outline: rectangle(ancestor.w, ancestor.h), localToWorld: polylineMatrix(doc, ancestor.id) });
    return result.reverse();
}

/** Canonical terminal resolution shared by staged geometry and attachment gestures. */
export async function resolvePolylinePoints(node: AttachedPolyline, doc: BoardDoc, surfaces: ReadonlyMap<NodeId, AttachmentSurface>, options: {
    readonly tolerance: number; readonly signal: AbortSignal; readonly cooperate?: () => Promise<void>; readonly check: () => void;
}): Promise<readonly Point[]> {
    const steps = polylinePointSteps(node, doc, surfaces, options.tolerance, options.check);
    let count = 0, started = performance.now();
    options.signal.throwIfAborted();
    for (;;) {
        const next = steps.next();
        if (next.done) { options.signal.throwIfAborted(); return next.value; }
        if (++count >= 256 || performance.now() - started >= 3) {
            options.signal.throwIfAborted();
            await (options.cooperate?.() ?? yieldToHost());
            options.signal.throwIfAborted(); count = 0; started = performance.now();
        }
    }
}

/** Resolve both bindings against one staged document and the renderer's actual attachment surfaces. */
export async function resolvePolylineAttachments(node: AttachedPolyline, options: PolylineAttachmentOptions): Promise<ResolvedPolylineAttachments> {
    return resolvePolylineAttachmentChain(node, options, new Set());
}
async function resolvePolylineAttachmentChain(node: AttachedPolyline, options: PolylineAttachmentOptions,
    ancestors: ReadonlySet<NodeId>): Promise<ResolvedPolylineAttachments> {
    if (ancestors.has(node.id)) throw new Error('Polyline attachment cycle cannot be resolved');
    if (ancestors.size >= 64) throw new RangeError('Polyline attachment chain exceeds its depth limit');
    const chain = new Set(ancestors); chain.add(node.id);
    const { runtime } = options, session = runtime.session, live = session.doc, doc = options.doc ?? live;
    const revision = doc.rev, liveRevision = live.rev, owner = session.owner, signal = options.signal ?? new AbortController().signal;
    const tolerance = options.toleranceWorld ?? POLYLINE_TOLERANCE_WORLD;
    let released = false, epoch: number | undefined;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === live
        && live.rev === liveRevision && doc.rev === revision && (epoch === undefined || runtime.render.text.fonts.epoch === epoch);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Polyline attachment source changed', 'AbortError'); };
    if (!Number.isFinite(tolerance) || tolerance <= 0 || node.points.length < 2 || doc.nodes.get(node.id) !== node) throw new RangeError('Invalid attached polyline');
    check();
    const entries = [node.startAttach ?? null, node.endAttach ?? null] as const;
    const targets = [...new Set(entries.flatMap(entry => entry ? [entry.target] : []))];
    const scope = await acquireBoardGeometryScope(runtime, [node.id, ...targets], { doc, signal, current, cooperate: options.cooperate });
    try {
        check(); epoch = runtime.render.text.fonts.epoch;
        const surfaces = new Map<NodeId, AttachmentSurface>();
        for (const id of targets) {
            const target = doc.nodes.get(id); if (!target) throw new Error(`Missing polyline attachment target: ${id}`);
            const geometry = await runtime.render.prepareForPick(target, signal, doc); check();
            let vector = geometry.vector;
            const targetLine = target.kind === 'polyline' ? target as AttachedPolyline : null;
            if (targetLine && (targetLine.startAttach || targetLine.endAttach)) {
                if (!vector) throw new Error(`Polyline attachment target geometry is unavailable: ${id}`);
                const resolved = await resolvePolylineAttachmentChain(targetLine, { ...options, doc, signal, current }, chain);
                try {
                    check(); vector = preparePolylineGeometry({ ...targetLine, points: [...resolved.points] }, { key: vector.key,
                        kernelVersion: 1, lengthError: 0.01, maxPieces: 8192, hitMarginCss: 4, hitErrorCss: 0.01 });
                } finally { resolved.release(); }
            }
            const surface = vector?.attachments ?? await prepareBoardAttachmentSurface(target, { vector, ink: geometry.ink, signal,
                cooperate: options.cooperate, toleranceWorld: tolerance / 2 });
            check(); if (!surface) throw new Error(`Polyline attachment target has no supported surface: ${id}`);
            if ('boundaryErrorWorld' in surface && surface.boundaryErrorWorld !== 0)
                throw new Error(`Polyline attachment target boundary is not exact: ${id}`);
            surfaces.set(id, { target: id, outline: surface.outline, logicalBox: surface.logicalBox,
                localToWorld: polylineMatrix(doc, id), clips: polylineSurfaceClips(doc, target), revision });
        }
        const points = await resolvePolylinePoints(node, doc, surfaces, { tolerance, signal, cooperate: options.cooperate, check });
        check();
        return { points, fontEpoch: epoch,
            release() { if (!released) { released = true; scope.release(); } } };
    } catch (error) { scope.release(); throw error; }
}
