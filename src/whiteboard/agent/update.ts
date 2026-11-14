import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import type { NodeSetOp, TxBuilder } from '../change/ops';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import { sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { plainRichText } from './create';
import { AgentOpRefused } from './errors';

export type UpdateOp = Extract<CanvasOp, { op: 'update' }>;
export interface UpdateContext {
    readonly doc: BoardDoc;
    readonly sheet: SheetId;
    readonly builder: TxBuilder;
    resolve(reference: string): NodeId;
    /** Computes placement/resize with authoritative staged scene geometry, or refuses. */
    placement(node: Node, op: UpdateOp): { readonly ops: readonly NodeSetOp[]; readonly notes?: readonly string[] };
}

export function editableNode(doc: BoardDoc, sheet: SheetId, id: NodeId): Node {
    const node = doc.nodes.get(id);
    if (!node || sheetOf(doc, id) !== sheet) throw new AgentOpRefused('shape is not on the current sheet');
    let current: Node | undefined = node;
    while (current) {
        if (current.locked) throw new AgentOpRefused('shape is locked or under a locked ancestor');
        current = doc.nodes.get(current.parent as NodeId);
    }
    return node;
}

// The scene computes world-axis changes; no unrotated box approximation may
// report a successful resize. Styles/text below never request geometry work.
export function stageAgentUpdate(op: UpdateOp, context: UpdateContext): { updated: readonly NodeId[]; notes: readonly string[] } {
    const id = context.resolve(op.id), node = editableNode(context.doc, context.sheet, id), builder = context.builder;
    const geometry = op.page !== undefined || op.x !== undefined || op.y !== undefined || op.w !== undefined
        || op.h !== undefined || op.rotation !== undefined;
    const placement = geometry ? context.placement(node, op) : { ops: [] as readonly NodeSetOp[], notes: [] as readonly string[] };
    if (op.text !== undefined && node.kind !== 'text' && node.kind !== 'sticky' && node.kind !== 'figure' && node.kind !== 'connector')
        throw new AgentOpRefused('shape does not support text');
    if (op.color !== undefined && node.kind !== 'stroke' && node.kind !== 'figure' && node.kind !== 'text'
        && node.kind !== 'sticky' && node.kind !== 'connector' && node.kind !== 'polyline') throw new AgentOpRefused('shape does not support color');
    if (op.fill !== undefined && node.kind !== 'stroke' && node.kind !== 'figure' && node.kind !== 'connector') throw new AgentOpRefused('shape does not support fill');
    if (op.dash !== undefined && node.kind !== 'stroke' && node.kind !== 'figure' && node.kind !== 'connector' && node.kind !== 'polyline') throw new AgentOpRefused('shape does not support dash');
    if (op.size !== undefined && node.kind !== 'stroke' && node.kind !== 'figure' && node.kind !== 'text'
        && node.kind !== 'sticky' && node.kind !== 'connector' && node.kind !== 'polyline') throw new AgentOpRefused('shape does not support size');
    for (const change of placement.ops) builder.push(change);
    if (op.text !== undefined) {
        if (node.kind === 'text' || node.kind === 'sticky') builder.push({ t: 'set', id, key: 'text', value: plainRichText(op.text) });
        else if (node.kind === 'figure' || node.kind === 'connector') builder.push({ t: 'set', id, key: 'label', value: op.text ? plainRichText(op.text) : null });
    }
    if (op.color !== undefined) builder.push({ t: 'set', id, key: 'color', value: op.color });
    if (op.fill !== undefined) builder.push({ t: 'set', id, key: 'fill', value: op.fill });
    if (op.dash !== undefined) builder.push({ t: 'set', id, key: 'dash', value: op.dash });
    if (op.size !== undefined) {
        if (node.kind === 'stroke') {
            const kind = node.tool === 'pen' ? 'stroke:pen' : 'stroke:highlighter';
            const width = styleGeometryMetrics.actualWidth(kind, op.size, 1);
            builder.push({ t: 'set', id, key: 'width', value: width });
            if (node.widthModel.id === 'pressure-linear-v1') {
                const ratio = width / node.width;
                builder.push({ t: 'set', id, key: 'widthModel', value: { id: 'pressure-linear-v1',
                    rMin: node.widthModel.rMin * ratio, rMax: node.widthModel.rMax * ratio } });
            }
        } else {
            builder.push({ t: 'set', id, key: 'size', value: op.size });
            if (node.kind === 'figure' || node.kind === 'connector' || node.kind === 'polyline') {
                builder.push({ t: 'set', id, key: 'width', value: styleGeometryMetrics.actualWidth(node.kind, op.size, 1) });
            }
        }
    }
    return { updated: [id], notes: placement.notes ?? [] };
}
