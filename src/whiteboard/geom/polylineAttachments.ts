import type { Affine } from '../../platform/types';
import { worldPose, worldToLocal } from '../change/coordinates';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Attachment, Node, Point, PolylineNode } from '../model/nodes';
import { transformPoint } from './affine';
import { connectorBody } from './connectors';
import { bodyCrossings, pointAtLength } from './connectorPath';
import type { AttachmentSurface } from './connectorTypes';
import type { PathOp } from './path';
import { preparePolylineGeometry } from './providers';
import { prepareBoardAttachmentSurface } from '../render/attachmentSurfaces';
import { boardFrameAncestors } from './ancestorFrames';

/** H4 owns the persisted fields; this reader also accepts documents predating them. */
type AttachedPolyline = Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
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
function matrix(doc: BoardDoc, id: NodeId): Affine {
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    if (![pose.x, pose.y, pose.rotation, c, s].every(Number.isFinite)) throw new RangeError('Polyline attachment pose is invalid');
    return [c, s, -s, c, pose.x, pose.y];
}
function rectangle(w: number, h: number): readonly PathOp[] {
    if (![w, h].every(Number.isFinite) || w < 0 || h < 0) throw new RangeError('Polyline attachment frame is invalid');
    return [{ op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' }];
}
export function polylineSurfaceClips(doc: BoardDoc, node: Readonly<Node>): AttachmentSurface['clips'] {
    const result: AttachmentSurface['clips'][number][] = [];
    for (const ancestor of boardFrameAncestors(doc, node))
        result.push({ outline: rectangle(ancestor.w, ancestor.h), localToWorld: matrix(doc, ancestor.id) });
    return result.reverse();
}

/** Canonical terminal resolution shared by staged geometry and attachment gestures. */
export async function resolvePolylinePoints(node: AttachedPolyline, doc: BoardDoc, surfaces: ReadonlyMap<NodeId, AttachmentSurface>, options: {
    readonly tolerance: number; readonly signal: AbortSignal; readonly cooperate?: () => Promise<void>; readonly check: () => void;
}): Promise<readonly Point[]> {
    options.check();
    if (!Number.isFinite(options.tolerance) || options.tolerance <= 0 || options.tolerance / 2 === 0) throw new RangeError('Invalid polyline attachment tolerance');
    const entries = [node.startAttach ?? null, node.endAttach ?? null] as const;
    const localToWorld = matrix(doc, node.id), points = node.points.map(point => ({ ...point }));
    if (points.length < 2) throw new RangeError('Invalid attached polyline');
    const world = points.map(point => transformPoint(localToWorld, point));
    const aim = (attachment: Attachment, surface: AttachmentSurface) => {
        const box = surface.logicalBox, anchor = attachment.precise || attachment.exact ? attachment.anchor : { x: 0.5, y: 0.5 }; // default, calibration cut by owner
        if (![box.x, box.y, box.width, box.height, anchor.x, anchor.y].every(Number.isFinite) || box.width < 0 || box.height < 0
            || anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1) throw new RangeError('Polyline attachment anchor is invalid');
        const point = transformPoint(surface.localToWorld, { x: box.x + box.width * anchor.x, y: box.y + box.height * anchor.y });
        if (![point.x, point.y].every(Number.isFinite)) throw new RangeError('Polyline attachment anchor overflows');
        return point;
    };
    for (let side = 0; side < 2; side++) {
        const entry = entries[side]; if (!entry) continue;
        const surface = surfaces.get(entry.target); if (!surface) throw new Error('Polyline attachment surface disappeared');
        world[side === 0 ? 0 : world.length - 1] = aim(entry, surface);
    }
    for (let side = 0; side < 2; side++) {
        const entry = entries[side]; if (!entry) continue;
        const index = side === 0 ? 0 : world.length - 1, neighbour = side === 0 ? 1 : world.length - 2;
        let point = world[index];
        if (!entry.exact) {
            const body = connectorBody(point, world[neighbour], 0, options.tolerance);
            const crossings = await bodyCrossings(body, surfaces.get(entry.target)!, options.tolerance / 2, 65_536, options.cooperate, options.signal);
            options.check(); const exit = crossings[0];
            if (exit && !exit.entering) point = pointAtLength(body, exit.distance);
        }
        const local = worldToLocal(doc, node, point);
        if (![local.x, local.y].every(Number.isFinite)) throw new RangeError('Polyline attachment point overflows');
        points[index] = local;
    }
    options.check(); return Object.freeze(points.map(point => Object.freeze(point)));
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
    const tolerance = options.toleranceWorld ?? 0.01;
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
                localToWorld: matrix(doc, id), clips: polylineSurfaceClips(doc, target), revision });
        }
        const points = await resolvePolylinePoints(node, doc, surfaces, { tolerance, signal, cooperate: options.cooperate, check });
        check();
        return { points, fontEpoch: epoch,
            release() { if (!released) { released = true; scope.release(); } } };
    } catch (error) { scope.release(); throw error; }
}
