import type { Affine } from '../../platform/types';
import { worldPose, worldToLocal } from '../change/coordinates';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Attachment, Node, Point, PolylineNode } from '../model/nodes';
import { transformPoint } from './affine';
import { connectorBody } from './connectors';
import { bodyCrossings, pointAtLength } from './connectorPath';
import type { AttachmentSurface } from './connectorTypes';
import type { PathOp } from './path';

// C-polyline binding resolution, shared by the async geometry scope (dependency
// closure and prepared points) and the attachment reader. It has no import of
// the scope, so the scope can call it without a cycle.

/** H4 owns the persisted fields; this also accepts documents predating them. */
export type AttachedPolyline = Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
export const TOLERANCE_WORLD = 0.01;

export function attachedPolylineTargets(node: Readonly<Node>): readonly NodeId[] {
    if (node.kind !== 'polyline') return [];
    const line = node as AttachedPolyline;
    return [...new Set([line.startAttach, line.endAttach].flatMap(entry => entry ? [entry.target] : []))];
}
export function isAttachedPolyline(node: Readonly<Node>): boolean {
    return attachedPolylineTargets(node).length > 0;
}
export function worldMatrix(doc: BoardDoc, id: NodeId): Affine {
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return [c, s, -s, c, pose.x, pose.y];
}
function rectangle(w: number, h: number): readonly PathOp[] {
    return [{ op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' }];
}
export function polylineSurfaceClips(doc: BoardDoc, node: Readonly<Node>): AttachmentSurface['clips'] {
    const result: AttachmentSurface['clips'][number][] = [];
    let parent = doc.nodes.get(node.parent as NodeId);
    for (let depth = 0; parent && depth < 64; depth++) {
        if (parent.kind === 'frame') result.push({ outline: rectangle(parent.w, parent.h), localToWorld: worldMatrix(doc, parent.id) });
        parent = doc.nodes.get(parent.parent as NodeId);
    }
    return result.reverse();
}
/** The renderer's actual attachment surface for one target, in the staged document's world. */
export function polylineSurface(doc: BoardDoc, target: Readonly<Node>, attachments: Pick<AttachmentSurface, 'outline' | 'logicalBox'>, revision: number): AttachmentSurface {
    return { target: target.id, outline: attachments.outline, logicalBox: attachments.logicalBox,
        localToWorld: worldMatrix(doc, target.id), clips: polylineSurfaceClips(doc, target), revision };
}

/** Both ends aimed at their surfaces, then pulled out along the body to its real exit crossing.
 * Returns local points; every await is cooperative and every step rechecks the caller's fence. */
export async function resolvePolylinePoints(node: AttachedPolyline, doc: BoardDoc, surfaces: ReadonlyMap<NodeId, AttachmentSurface>, options: {
    readonly tolerance: number; readonly signal: AbortSignal; readonly cooperate?: () => Promise<void>; readonly check: () => void;
}): Promise<readonly Point[]> {
    const { tolerance, signal, check } = options;
    const entries = [node.startAttach ?? null, node.endAttach ?? null] as const;
    const localToWorld = worldMatrix(doc, node.id), points = node.points.map(point => ({ ...point }));
    const world = points.map(point => transformPoint(localToWorld, point));
    const aim = (attachment: Attachment, surface: AttachmentSurface) => {
        const box = surface.logicalBox, anchor = attachment.precise || attachment.exact ? attachment.anchor : { x: 0.5, y: 0.5 };
        return transformPoint(surface.localToWorld, { x: box.x + box.width * anchor.x, y: box.y + box.height * anchor.y });
    };
    for (let side = 0; side < 2; side++) {
        const entry = entries[side]; if (!entry) continue;
        const surface = surfaces.get(entry.target); if (!surface) throw new Error(`Polyline attachment surface missing: ${entry.target}`);
        world[side === 0 ? 0 : world.length - 1] = aim(entry, surface);
    }
    for (let side = 0; side < 2; side++) {
        const entry = entries[side]; if (!entry) continue;
        const index = side === 0 ? 0 : world.length - 1, neighbour = side === 0 ? 1 : world.length - 2;
        let point = world[index];
        if (!entry.exact) {
            const surface = surfaces.get(entry.target)!;
            const body = connectorBody(point, world[neighbour], 0, tolerance);
            const crossings = await bodyCrossings(body, surface, tolerance, 65_536, options.cooperate, signal);
            check(); const exit = crossings.find(value => !value.entering);
            if (exit) point = pointAtLength(body, exit.distance);
        }
        points[index] = worldToLocal(doc, node, point);
    }
    check();
    return Object.freeze(points.map(point => Object.freeze(point)));
}
