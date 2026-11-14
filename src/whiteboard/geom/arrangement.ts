import { isLocked } from '../change/commands';
import type { Op, Transaction, TransactionOrigin } from '../change/ops';
import { isSheetParent } from '../model/doc';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { align, distribute, pack, stack } from './arrange';
import type { ArrangeItem, ArrangeMove } from './arrange';
import type { ArrangementAction, ArrangementServices } from './arrangement.types';
import { TranslationPlan } from './translation';

export function arrangementTransaction(doc: BoardDoc, selected: readonly NodeId[], action: ArrangementAction,
    services: ArrangementServices, origin: TransactionOrigin = 'tool'): Transaction {
    const selectedSet = new Set(selected), items: ArrangeItem[] = [];
    for (const id of selectedSet) {
        const node = doc.nodes.get(id);
        if (!node || node.kind === 'opaque' || isLocked(doc, node)) continue;
        let parent = node.parent, covered = false;
        for (let depth = 0; !isSheetParent(doc, parent); depth++) {
            if (depth >= 64) throw new RangeError('Selection hierarchy exceeds its depth limit');
            if (selectedSet.has(parent as NodeId)) { covered = true; break; }
            const ancestor = doc.nodes.get(parent as NodeId);
            if (!ancestor) throw new RangeError('Selection has a missing ancestor');
            parent = ancestor.parent;
        }
        if (!covered) items.push({ id, bounds: services.logicalBounds(id), order: services.rank(id) });
    }
    let moves: readonly ArrangeMove[];
    switch (action.kind) {
        case 'align': moves = align(items, action.mode); break;
        case 'distribute': moves = distribute(items, action.axis); break;
        case 'stack': moves = stack(items, action.axis); break;
        case 'pack': moves = pack(items); break;
    }
    const ops: Op[] = [];
    for (const item of moves) {
        const plan = new TranslationPlan(doc, [item.id], services.geometry);
        ops.push(...plan.preview(item.delta).ops);
    }
    return { origin, label: `Arrange ${action.kind}`, ops };
}
