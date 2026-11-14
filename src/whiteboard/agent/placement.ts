import type { NodeSetOp } from '../change/ops';
import { isSheetParent } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node, Point } from '../model/nodes';
import { boardPageStack } from '../model/pages';
import { createPage, type CreateContext } from './create';
import { AgentOpRefused } from './errors';
import type { UpdateOp } from './update';

export interface LocalBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface PlacementContext extends CreateContext {
    /** Exact unrotated placement box (not stroke ink), recomputed for a candidate and staged doc. */
    localBox(node: Node): LocalBox;
}
interface Transform { readonly x: number; readonly y: number; readonly angle: number }
function rotate(point: Point, angle: number): Point {
    const c = Math.cos(angle), s = Math.sin(angle);
    return { x: c * point.x - s * point.y, y: s * point.x + c * point.y };
}
function normalize(angle: number): number { return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); }
function isBox(node: Node): node is Extract<Node, { w: number; h: number }> {
    return node.kind === 'figure' || node.kind === 'frame' || node.kind === 'picture' || node.kind === 'clip'
        || node.kind === 'linkcard' || node.kind === 'embed';
}
function parentTransform(context: PlacementContext, node: Node, page: number): Transform {
    const { doc } = context;
    const parents: Node[] = [];
    let parent = node.parent;
    while (!isSheetParent(doc, parent)) {
        const record = doc.nodes.get(parent as NodeId);
        if (!record || parents.length >= 64) throw new AgentOpRefused('invalid ancestor chain');
        parents.push(record); parent = record.parent;
    }
    const origin = page < 0 ? undefined : boardPageStack(doc.host)?.rects[page];
    if (page >= 0 && !origin) throw new AgentOpRefused('page does not exist');
    let result: Transform = { x: origin?.x ?? 0, y: origin?.y ?? 0, angle: 0 };
    for (let i = parents.length - 1; i >= 0; i--) {
        const p = parents[i], moved = rotate(p, result.angle);
        result = { x: result.x + moved.x, y: result.y + moved.y, angle: result.angle + p.rotation };
    }
    return result;
}
function rootPage(context: PlacementContext, node: Node): number {
    let root = node;
    while (!isSheetParent(context.doc, root.parent)) {
        const parent = context.doc.nodes.get(root.parent as NodeId);
        if (!parent) throw new AgentOpRefused('invalid ancestor chain');
        root = parent;
    }
    return root.page;
}
function center(box: LocalBox): Point { return { x: box.x + box.w / 2, y: box.y + box.h / 2 }; }

// C8: x/y and w/h describe the unrotated rectangle; rotation is absolute about
// its centre. Exact local boxes come from the same projection as canvas_shapes.
export function planAgentPlacement(node: Node, op: UpdateOp, context: PlacementContext): { readonly ops: readonly NodeSetOp[]; readonly notes: readonly string[] } {
    const oldPage = rootPage(context, node), root = isSheetParent(context.doc, node.parent);
    if (context.doc.kind !== 'whiteboard' && op.page !== undefined && !root && op.page - 1 !== oldPage) throw new AgentOpRefused('move the parent to change a nested shape’s page');
    const target = createPage(context, op.page ?? (oldPage >= 0 ? oldPage + 1 : undefined));
    const oldParent = parentTransform(context, node, oldPage), oldBox = context.localBox(node);
    const oldCenterOffset = rotate(center(oldBox), oldParent.angle + node.rotation);
    const oldOriginOffset = rotate(node, oldParent.angle);
    const worldCenter = { x: oldParent.x + oldOriginOffset.x + oldCenterOffset.x,
        y: oldParent.y + oldOriginOffset.y + oldCenterOffset.y };
    const oldPageOrigin = oldPage < 0 ? undefined : boardPageStack(context.doc.host)?.rects[oldPage];
    const oldX = worldCenter.x - (oldPageOrigin?.x ?? 0) - oldBox.w / 2;
    const oldY = worldCenter.y - (oldPageOrigin?.y ?? 0) - oldBox.h / 2;
    let candidate = node;
    const ops: NodeSetOp[] = [];
    if (op.w !== undefined || op.h !== undefined) {
        if (node.kind === 'text' && op.w !== undefined && op.h === undefined) {
            candidate = { ...node, w: op.w, autoSize: false };
            ops.push({ t: 'set', id: node.id, key: 'w', value: op.w }, { t: 'set', id: node.id, key: 'autoSize', value: false });
        } else if (node.kind === 'stroke' || node.kind === 'polyline') {
            if ((op.w !== undefined && oldBox.w <= 0) || (op.h !== undefined && oldBox.h <= 0))
                throw new AgentOpRefused('a zero-extent axis cannot be resized');
            const sx = op.w === undefined ? 1 : op.w / oldBox.w, sy = op.h === undefined ? 1 : op.h / oldBox.h;
            if (node.kind === 'stroke') {
                candidate = { ...node, sx: node.sx * sx, sy: node.sy * sy };
                if (op.w !== undefined) ops.push({ t: 'set', id: node.id, key: 'sx', value: candidate.sx });
                if (op.h !== undefined) ops.push({ t: 'set', id: node.id, key: 'sy', value: candidate.sy });
            } else {
                const points = node.points.map(point => ({ x: oldBox.x + (point.x - oldBox.x) * sx,
                    y: oldBox.y + (point.y - oldBox.y) * sy }));
                candidate = { ...node, points };
                ops.push({ t: 'set', id: node.id, key: 'points', value: points });
            }
        } else {
            if (!isBox(node)) throw new AgentOpRefused('this shape cannot be resized by the agent');
            candidate = { ...node, w: op.w ?? node.w, h: op.h ?? node.h };
            if (op.w !== undefined) ops.push({ t: 'set', id: node.id, key: 'w', value: op.w });
            if (op.h !== undefined) ops.push({ t: 'set', id: node.id, key: 'h', value: op.h });
        }
    }
    const newBox = context.localBox(candidate);
    if ((op.w !== undefined && Math.abs(newBox.w - op.w) > 0.01)
        || (op.h !== undefined && Math.abs(newBox.h - op.h) > 0.01)) {
        throw new AgentOpRefused('requested size cannot be represented exactly');
    }
    const parent = parentTransform(context, node, target.page);
    const rotation = op.rotation === undefined ? node.rotation : normalize((op.rotation % 360) * Math.PI / 180 - parent.angle);
    if (op.rotation !== undefined) ops.push({ t: 'set', id: node.id, key: 'rotation', value: rotation });
    const raw = { x: op.x ?? oldX, y: op.y ?? oldY };
    const desired = op.x !== undefined || op.y !== undefined || op.page !== undefined ? target.clamp(raw) : raw;
    const changeX = op.x !== undefined || op.page !== undefined, changeY = op.y !== undefined || op.page !== undefined;
    if ((!changeX || desired.x === raw.x) && (!changeY || desired.y === raw.y)) target.notes.length = 0;
    const x = changeX ? desired.x : oldX;
    const y = changeY ? desired.y : oldY;
    const pageOrigin = target.page < 0 ? undefined : boardPageStack(context.doc.host)?.rects[target.page];
    const wantedCenter = { x: (pageOrigin?.x ?? 0) + x + newBox.w / 2, y: (pageOrigin?.y ?? 0) + y + newBox.h / 2 };
    const localCenter = rotate({ x: wantedCenter.x - parent.x, y: wantedCenter.y - parent.y }, -parent.angle);
    const localOffset = rotate(center(newBox), rotation);
    if (root && target.page !== oldPage) ops.push({ t: 'set', id: node.id, key: 'page', value: target.page });
    ops.push({ t: 'set', id: node.id, key: 'x', value: localCenter.x - localOffset.x });
    ops.push({ t: 'set', id: node.id, key: 'y', value: localCenter.y - localOffset.y });
    return { ops, notes: target.notes };
}
