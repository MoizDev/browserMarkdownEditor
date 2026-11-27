import type { Affine } from '../../platform/types';
import type { WorldPose } from '../change/coordinates';
import { compose } from '../geom/affine';
import { transformBox, validBox, type Box } from '../geom/bounds';
import { polylinePath } from '../geom/polylines';
import { isAttachedPolyline } from '../geom/polylineResolve';
import { transformedPathBounds } from '../geom/providers';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Node, Point } from '../model/nodes';

export type LogicalPrepared = Awaited<ReturnType<BoardRuntime['render']['prepareForPick']>>;
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
export type LogicalBox = Box;

export function matrix(p: WorldPose): Affine {
    const c = Math.cos(p.rotation), s = Math.sin(p.rotation);
    return [c, s, -s, c, p.x, p.y];
}
export function union(a: Box | null, b: Box): Box {
    if (!validBox(b)) throw new Error('Invalid prepared logical geometry');
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}
export function transformed(box: Box, m: Affine): Box {
    const out = new Float64Array(4); transformBox(out, 0, box, 0, m, 0); return [out[0], out[1], out[2], out[3]];
}
export function rectBox(rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Box {
    return [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
}

export interface LogicalSource {
    prepared(id: NodeId): LogicalPrepared | undefined;
    polylinePoints(id: NodeId): readonly Point[] | undefined;
    children(id: NodeId): readonly Node[];
    pose(id: NodeId): WorldPose;
    check(): void;
}
export type LogicalDue = () => boolean;

export function* logicalLeafBox(source: LogicalSource, node: Readonly<Node>, targetFromWorld: Affine, due: LogicalDue): Generator<void, Box, void> {
    const value = source.prepared(node.id); if (!value) throw new Error(`Geometry not prepared: ${node.id}`);
    const nodeToTarget = compose(targetFromWorld, matrix(source.pose(node.id)));
    let box: Box | null = null;
    if (node.kind === 'connector') {
        if (!value.connector) throw new Error(`Connector geometry unavailable: ${node.id}`);
        for (const path of [value.connector.body, ...value.connector.heads]) {
            const bounds = transformedPathBounds(path, targetFromWorld);
            if (bounds) { const r = node.width / 2; box = union(box, [bounds.x - r, bounds.y - r, bounds.x + bounds.width + r, bounds.y + bounds.height + r]); }
            if (due()) yield;
        }
        if (value.connector.label) {
            const label = value.connector.label, ink = label.paint.ink;
            box = union(box, transformed(rectBox(ink), compose(targetFromWorld, label.localToWorld)));
        }
    } else if (node.kind === 'stroke') {
        if (!value.ink) throw new Error(`Ink geometry unavailable: ${node.id}`);
        const c = nodeToTarget, point = (x: number, y: number, radius: number) => {
            const px = c[0] * x + c[2] * y + c[4], py = c[1] * x + c[3] * y + c[5];
            const rx = radius * Math.hypot(c[0], c[2]), ry = radius * Math.hypot(c[1], c[3]);
            box = union(box, [px - rx, py - ry, px + rx, py + ry]);
        };
        for (const part of value.ink) {
            for (let i = 0; i < part.segments.length; i += 6) {
                point(part.segments[i], part.segments[i + 1], part.segments[i + 2]);
                point(part.segments[i + 3], part.segments[i + 4], part.segments[i + 5]);
                if (due()) yield;
            }
            for (let i = 0; i < part.discs.length; i += 3) { point(part.discs[i], part.discs[i + 1], part.discs[i + 2]); if (due()) yield; }
        }
    } else if (node.kind === 'polyline') {
        const resolved = source.polylinePoints(node.id);
        if (!resolved && isAttachedPolyline(node)) throw new Error(`Attached polyline geometry is unresolved: ${node.id}`);
        const bounds = transformedPathBounds(polylinePath(resolved ? { ...node, points: [...resolved] } : node), nodeToTarget);
        if (bounds) box = rectBox(bounds);
    } else {
        if (!value.vector) throw new Error(`Vector geometry unavailable: ${node.id}`);
        box = transformed(rectBox(value.vector.boxLocal), nodeToTarget);
    }
    if (!box) throw new Error(`Logical geometry is empty: ${node.id}`);
    return box;
}

export function* logicalAggregateBox(source: LogicalSource, root: Readonly<Node>, targetFromWorld: Affine, due: LogicalDue): Generator<void, Box, void> {
    const stack: Readonly<Node>[] = [root]; let box: Box | null = null;
    while (stack.length) {
        const node = stack.pop()!;
        if (node.kind === 'group' || (root.kind === 'group' && node.kind === 'frame')) {
            for (const child of source.children(node.id)) { stack.push(child); if (due()) yield; }
            if (node.kind === 'group') continue;
        }
        box = union(box, yield* logicalLeafBox(source, node, targetFromWorld, due)); source.check();
        if (due()) yield;
    }
    if (!box) throw new Error(`Empty group has no logical geometry: ${root.id}`);
    return box;
}
