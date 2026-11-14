import type { CanvasOp } from '../../../shared/vaultAgentProtocol';
import { ApplyRefused } from '../change/apply';
import type { NodeSetOp, Op } from '../change/ops';
import type { SampleBuilder } from '../ink/samples';
import { sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Node, Point } from '../model/nodes';
import type { SampleLease } from '../model/samples';
import { stageSimpleCreate } from './create';
import { stageInkCreate } from './createInk';
import { AgentOpRefused } from './errors';
import type { AgentOpContext, AgentOpResult } from './transaction';
import { editableNode, stageAgentUpdate, type UpdateOp } from './update';

export interface AgentStageHost {
    readonly doc: BoardDoc;
    readonly sheet: SheetId;
    readonly currentPage: number;
    admitSamples(builder: SampleBuilder): SampleLease;
    /** Authoritative current staged world geometry, expressed in the destination page. */
    target(node: Node, page: number): Point;
    placement(node: Node, op: UpdateOp): { readonly ops: readonly NodeSetOp[]; readonly notes?: readonly string[] };
    /** Shared deletion command; translate its expected refusals to AgentOpRefused. */
    delete(id: NodeId): { readonly ops: readonly Op[]; readonly kept: readonly NodeId[] };
}

export function stageAgentOp(host: AgentStageHost, op: CanvasOp, context: AgentOpContext): AgentOpResult {
    const base = { doc: host.doc, sheet: host.sheet, currentPage: host.currentPage, builder: context.builder };
    if (op.op === 'create') {
        if (op.type === 'arrow' || op.type === 'draw') {
            const created = stageInkCreate(op, { ...base, admit: samples => host.admitSamples(samples),
                target: (reference, page) => {
                    const id = context.resolve(reference), node = host.doc.nodes.get(id);
                    if (!node || sheetOf(host.doc, id) !== host.sheet) throw new AgentOpRefused('target is not on the current sheet');
                    if (node.kind === 'connector' || node.kind === 'group' || node.kind === 'opaque') throw new AgentOpRefused('shape cannot be a connector target');
                    return { id, center: host.target(node, page) };
                } });
            return { created: created.id, notes: created.notes };
        }
        const created = stageSimpleCreate(op, base);
        return { created: created.id, notes: created.notes };
    }
    if (op.op === 'update') return stageAgentUpdate(op, { ...base, resolve: context.resolve,
        placement: (node, update) => host.placement(node, update) });
    const deleted: NodeId[] = [], notes: string[] = [], problems: string[] = [];
    for (const reference of op.ids) {
        const point = context.builder.savepoint();
        try {
            const id = context.resolve(reference);
            editableNode(host.doc, host.sheet, id);
            const plan = host.delete(id);
            for (const change of plan.ops) context.builder.push(change);
            deleted.push(id);
            if (plan.kept.length) notes.push(`kept ${plan.kept.length} locked descendant${plan.kept.length === 1 ? '' : 's'}`);
        } catch (error) {
            if (!(error instanceof AgentOpRefused) && !(error instanceof ApplyRefused)) throw error;
            context.builder.rollbackTo(point);
            problems.push(`${reference}: ${error.message}`);
        }
    }
    return { deleted, notes, problems };
}
