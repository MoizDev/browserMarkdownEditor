import type { Affine } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import type { ChangeGeometry } from '../change/coordinates';
import { ApplyFailed } from '../change/errors';
import type { BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { ConnectorNode, Node } from '../model/nodes';
import type { BoardVectorGeometry } from '../render/vectorGeometry';
import type { LocalGeometryBounds } from '../scene/bounds';
import { transformBox, validBox } from './bounds';
import type { Box } from './bounds';
import type { AttachmentSurface, ConnectorLabelPaint } from './connectorTypes';
import type { PathOp, Vec2 } from './path';
import { resolveConnectorGeometryNow } from './resolveConnector';

// Provenance: staged-change world pose and shared connector attachment/geometry
// contracts; independent composition, no third-party source.
export type ConnectorLabelLayout = ConnectorLabelPaint;
export function createBoardChangeGeometry(options: {
    local: (doc: BoardDoc, node: Readonly<Node>) => LocalGeometryBounds | undefined;
    vector: (doc: BoardDoc, node: Readonly<Node>) => BoardVectorGeometry | undefined;
    connectorText?: (doc: BoardDoc, node: Readonly<ConnectorNode>, anchor: Vec2, length: number) => ConnectorLabelLayout | undefined;
}): ChangeGeometry {
    const unavailable = (id: string, detail: string): never => { throw new ApplyFailed('geometry-unavailable', `Geometry unavailable for ${id}: ${detail}`); };
    const matrix = (doc: BoardDoc, id: NodeId): Affine => {
        const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        return [c, s, -s, c, pose.x, pose.y];
    };
    const frameOutline = (w: number, h: number): readonly PathOp[] => [
        { op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' },
    ];
    const clips = (doc: BoardDoc, node: Readonly<Node>): AttachmentSurface['clips'] => {
        const result: AttachmentSurface['clips'][number][] = [];
        let parent = node.parent;
        for (let depth = 0; depth < 64; depth++) {
            if (doc.sheets.has(parent as SheetId)) { result.reverse(); return result; }
            const current = doc.nodes.get(parent as NodeId);
            if (!current) return unavailable(node.id, 'missing ancestor');
            if (current.kind === 'frame') result.push({ outline: frameOutline(current.w, current.h), localToWorld: matrix(doc, current.id) });
            parent = current.parent;
        }
        return unavailable(node.id, 'ancestor depth exceeded');
    };
    const surface = (doc: BoardDoc, id: NodeId): AttachmentSurface | undefined => {
        const target = doc.nodes.get(id);
        if (!target) return undefined;
        const shape = options.vector(doc, target)?.attachments;
        if (!shape) return unavailable(id, 'attachment contour is not prepared');
        return { target: id, outline: shape.outline, logicalBox: shape.logicalBox,
            localToWorld: matrix(doc, id), clips: clips(doc, target), revision: doc.rev };
    };
    const connector = (doc: BoardDoc, node: Readonly<ConnectorNode>, includeLabel: boolean) => {
        if (includeLabel && node.label && !options.connectorText) return unavailable(node.id, 'connector text layout is not prepared');
        const result = resolveConnectorGeometryNow({ key: `staged:${node.id}:${doc.rev}`, node,
            localToWorld: matrix(doc, node.id), resolveTarget: id => surface(doc, id), label: null,
            toleranceWorld: .01, maxPieces: 65_536 }, includeLabel && node.label ? { label(anchor, length) {
                return options.connectorText!(doc, node, anchor, length) ?? unavailable(node.id, 'connector text layout is not prepared');
            } } : {});
        if (result.status === 'pending') return unavailable(node.id, `connector ${result.reason} is pending`);
        if (result.status === 'unroutable') return unavailable(node.id, result.reason);
        return result.geometry;
    };
    const box = (doc: BoardDoc, node: Readonly<Node>): Box => {
        if (node.kind === 'connector') {
            const r = connector(doc, node, true).inkBoundsWorld;
            const value: Box = [r.x, r.y, r.x + r.width, r.y + r.height];
            if (!validBox(value)) return unavailable(node.id, 'invalid connector bounds');
            return value;
        }
        const local = options.local(doc, node);
        if (!local || !validBox(local.ink)) return unavailable(node.id, 'exact local ink bounds are not prepared');
        const out = new Float64Array(4);
        transformBox(out, 0, local.ink, 0, matrix(doc, node.id));
        return [out[0], out[1], out[2], out[3]];
    };
    return {
        resolvedTip(doc, node, terminal) {
            const current = doc.nodes.get(node.id);
            if (!current || current.kind !== 'connector') return unavailable(node.id, 'connector is missing');
            return connector(doc, current, false)[terminal].tipWorld;
        },
        worldBoundsCenter(doc, node) {
            const root = doc.nodes.get(node.id);
            if (!root) return unavailable(node.id, 'node is missing');
            const pending: Readonly<Node>[] = [root];
            let union: [number, number, number, number] | undefined;
            while (pending.length) {
                const current = pending.pop()!;
                if (current.kind === 'group' || (root.kind === 'group' && current.kind === 'frame')) {
                    const children = doc.children.get(current.id) ?? [];
                    for (const child of children) pending.push(child);
                    if (current.kind === 'group') continue;
                }
                const b = box(doc, current);
                if (!union) union = [b[0], b[1], b[2], b[3]];
                else { union[0] = Math.min(union[0], b[0]); union[1] = Math.min(union[1], b[1]); union[2] = Math.max(union[2], b[2]); union[3] = Math.max(union[3], b[3]); }
            }
            if (!union) return unavailable(node.id, 'empty group has no bounds');
            return { x: union[0] / 2 + union[2] / 2, y: union[1] / 2 + union[3] / 2 };
        },
    };
}
