import type { Affine } from '../../platform/types';
import type { ChangeGeometry, WorldPose } from '../change/coordinates';
import { worldPose } from '../change/coordinates';
import { inverse, transformPoint } from '../geom/affine';
import type { AttachmentSurface } from '../geom/connectorTypes';
import { drainPolylinePoints, POLYLINE_TOLERANCE_WORLD, polylineMatrix, type AttachedPolyline } from '../geom/polylinePoints';
import { attachedPolylineTargets, isAttachedPolyline, polylineSurface, polylineSurfaceClips } from '../geom/polylineResolve';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { ConnectorNode, Node, Point, PolylineNode } from '../model/nodes';
import { IDENTITY, logicalAggregateBox, matrix, type LogicalSource } from './logicalGeometry';

export interface StagedBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface StagedGeometryReader {
    worldBox(node: Readonly<Node>): StagedBox;
    localBox(node: Readonly<Node>): StagedBox;
    resolvedTip: ChangeGeometry['resolvedTip'];
    resolvedPolylineTip(doc: BoardDoc, polyline: PolylineNode, terminal: 'start' | 'end'): Point;
}

function settle<T>(work: Generator<void, T, void>): T {
    for (;;) { const step = work.next(); if (step.done) return step.value; }
}
function hasLeaf(doc: BoardDoc, root: Readonly<Node>): boolean {
    const pending: Readonly<Node>[] = [root];
    while (pending.length) {
        const value = pending.pop()!;
        if (value.kind !== 'group') return true;
        for (const child of doc.children.get(value.id) ?? []) pending.push(child);
    }
    return false;
}
function dependencyIds(doc: BoardDoc, root: Readonly<Node>): NodeId[] {
    const found = new Set<NodeId>([root.id]), pending: Readonly<Node>[] = [root];
    while (pending.length) {
        const node = pending.pop()!;
        for (const target of attachedPolylineTargets(node)) found.add(target);
        for (const child of doc.children.get(node.id) ?? []) pending.push(child);
    }
    return [...found];
}

export function createStagedGeometryReader(render: BoardRuntime['render'], doc: BoardDoc, signal: AbortSignal): StagedGeometryReader {
    const pose = (id: NodeId): WorldPose => worldPose(doc, id);
    const ZERO: StagedBox = { x: 0, y: 0, w: 0, h: 0 };
    const resolver = (memo: Map<NodeId, readonly Point[]>) => (id: NodeId): readonly Point[] | undefined => {
        const node = doc.nodes.get(id);
        if (!node || node.kind !== 'polyline' || !isAttachedPolyline(node)) return undefined;
        const known = memo.get(id); if (known) return known;
        const surfaces = new Map<NodeId, AttachmentSurface>();
        for (const targetId of attachedPolylineTargets(node)) {
            const target = doc.nodes.get(targetId); if (!target) throw new Error(`Polyline attachment target is missing: ${targetId}`);
            const attachments = render.prepareForPickNow(target, signal, doc).vector?.attachments;
            if (!attachments) throw new Error(`Polyline attachment target has no supported surface: ${targetId}`);
            surfaces.set(targetId, polylineSurface(doc, target, attachments, doc.rev, polylineSurfaceClips(doc, target)));
        }
        const points = drainPolylinePoints(node as AttachedPolyline, doc, surfaces, POLYLINE_TOLERANCE_WORLD, () => signal.throwIfAborted());
        memo.set(id, points);
        return points;
    };
    const measure = (id: NodeId, targetFromWorld: Affine, empty: StagedBox): StagedBox => {
        const root = doc.nodes.get(id);
        if (!root) throw new Error(`Node is not in the staged document: ${id}`);
        if (root.kind === 'group' && !hasLeaf(doc, root)) return empty;
        const lease = render.pinChangeGeometryNow(dependencyIds(doc, root), signal, doc);
        try {
            const points = resolver(new Map());
            const source: LogicalSource = {
                prepared: leaf => {
                    const value = doc.nodes.get(leaf);
                    return value && value.kind !== 'group' ? render.prepareForPickNow(value, signal, doc) : undefined;
                },
                polylinePoints: points,
                children: parent => doc.children.get(parent) ?? [],
                pose,
                check: () => signal.throwIfAborted(),
            };
            const box = settle(logicalAggregateBox(source, root, targetFromWorld, () => false));
            return { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] };
        } finally { lease.release(); }
    };
    return {
        worldBox(node) {
            const origin = pose(node.id);
            return measure(node.id, IDENTITY, { x: origin.x, y: origin.y, w: 0, h: 0 });
        },
        localBox(node) {
            const back = inverse(matrix(pose(node.id)), 1e12);
            if (!back) throw new Error(`Geometry transform is not invertible: ${node.id}`);
            return measure(node.id, back, ZERO);
        },
        resolvedPolylineTip(candidate, line, terminal) {
            if (candidate !== doc) throw new Error('Staged geometry document mismatch');
            const current = doc.nodes.get(line.id);
            if (!current || current.kind !== 'polyline') throw new Error(`Polyline is not in the staged document: ${line.id}`);
            const lease = render.pinChangeGeometryNow(dependencyIds(doc, current), signal, doc);
            try {
                const points = resolver(new Map())(current.id) ?? current.points;
                const end = points[terminal === 'start' ? 0 : points.length - 1];
                if (!end) throw new Error(`Polyline end is missing: ${current.id}`);
                return transformPoint(polylineMatrix(doc, current.id), end);
            } finally { lease.release(); }
        },
        resolvedTip: (candidate, connector: ConnectorNode, terminal: 'start' | 'end'): Point => render.changeGeometry.resolvedTip(candidate, connector, terminal),
    };
}
