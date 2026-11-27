import type { Affine } from '../../platform/types';
import { worldPose, worldToLocal } from '../change/coordinates';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Attachment, Point, PolylineNode } from '../model/nodes';
import { transformPoint } from './affine';
import { connectorBody } from './connectors';
import { bodyCrossingSteps, pointAtLength } from './connectorPath';
import type { AttachmentSurface } from './connectorTypes';

export type AttachedPolyline = Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
export const POLYLINE_TOLERANCE_WORLD = 0.01;
const CROSSING_PIECES = 65_536;

export function polylineMatrix(doc: BoardDoc, id: NodeId): Affine {
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    if (![pose.x, pose.y, pose.rotation, c, s].every(Number.isFinite)) throw new RangeError('Polyline attachment pose is invalid');
    return [c, s, -s, c, pose.x, pose.y];
}

export function* polylinePointSteps(node: AttachedPolyline, doc: BoardDoc, surfaces: ReadonlyMap<NodeId, AttachmentSurface>,
    tolerance: number, check: () => void): Generator<void, readonly Point[]> {
    check();
    if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance / 2 === 0) throw new RangeError('Invalid polyline attachment tolerance');
    const entries = [node.startAttach ?? null, node.endAttach ?? null] as const;
    const localToWorld = polylineMatrix(doc, node.id), points = node.points.map(point => ({ ...point }));
    if (points.length < 2) throw new RangeError('Invalid attached polyline');
    const world = points.map(point => transformPoint(localToWorld, point));
    const aim = (attachment: Attachment, surface: AttachmentSurface) => {
        const box = surface.logicalBox, anchor = attachment.precise || attachment.exact ? attachment.anchor : { x: 0.5, y: 0.5 };
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
        const surface = surfaces.get(entry.target); if (!surface) throw new Error('Polyline attachment surface disappeared');
        let point = world[index];
        if (!entry.exact) {
            const body = connectorBody(point, world[neighbour], 0, tolerance);
            const crossings = yield* bodyCrossingSteps(body, surface, tolerance / 2, CROSSING_PIECES);
            check(); const exit = crossings[0];
            if (exit && !exit.entering) point = pointAtLength(body, exit.distance);
        }
        const local = worldToLocal(doc, node, point);
        if (![local.x, local.y].every(Number.isFinite)) throw new RangeError('Polyline attachment point overflows');
        points[index] = local;
    }
    check(); return Object.freeze(points.map(point => Object.freeze(point)));
}

export function drainPolylinePoints(node: AttachedPolyline, doc: BoardDoc, surfaces: ReadonlyMap<NodeId, AttachmentSurface>,
    tolerance: number, check: () => void = () => {}): readonly Point[] {
    const steps = polylinePointSteps(node, doc, surfaces, tolerance, check);
    for (;;) {
        const next = steps.next();
        if (next.done) return next.value;
    }
}
