import type { Op, Transaction } from '../../change/ops';
import type { BoardDoc } from '../../model/doc';
import type { NodeId } from '../../model/ids';
import type { Node } from '../../model/nodes';
import type { TextLayoutEngine, TextLayoutRequest } from '../paint';
import { EMPTY_RICH_TEXT, spliceRichText, type RichText } from '../richText';
import type { TextEditTransactionPreparer } from './bindingTypes';

/** Compute stored text bounds as part of the triggering edit, never on font arrival. */
export function createTextEditGrowth(doc: BoardDoc, id: NodeId, engine: TextLayoutEngine,
    request: (node: Readonly<Node>, text: RichText) => TextLayoutRequest): TextEditTransactionPreparer {
    return (transaction: Transaction): Transaction => {
        const original = doc.nodes.get(id);
        if (!original || (original.kind !== 'text' && original.kind !== 'sticky' && original.kind !== 'figure')) return transaction;
        let node: Node = original, changed = false, deleted = false;
        for (const op of transaction.ops) {
            if (op.t === 'delete' && op.id === id) { deleted = true; break; }
            if (op.t === 'set' && op.id === id) {
                node = { ...node, [op.key]: op.value } as Node;
                if (['text', 'label', 'w', 'h', 'font', 'size', 'labelScale', 'width', 'fit', 'autoSize'].includes(op.key)) changed = true;
            } else if (op.t === 'splice' && op.id === id) {
                const value = op.key === 'text' && (node.kind === 'text' || node.kind === 'sticky') ? node.text
                    : op.key === 'label' && node.kind === 'figure' ? node.label ?? EMPTY_RICH_TEXT : null;
                if (!value) continue;
                const next = spliceRichText(value, op.from, op.to, op.insert, op.wholeBlocks === true || op.replaceBlocks === true).text;
                node = { ...node, [op.key]: next } as Node;
                changed = true;
            }
        }
        if (!changed || deleted || (node.kind !== 'text' && node.kind !== 'sticky' && node.kind !== 'figure')) return transaction;
        const text = node.kind === 'figure' ? node.label ?? EMPTY_RICH_TEXT : node.text;
        const result = engine.measure(request(node, text));
        let followOn: Op | undefined;
        if (node.kind === 'text' && node.autoSize) {
            const width = Math.max(1, result.box.w);
            if (width !== node.w) followOn = { t: 'set', id, key: 'w', value: width };
        } else if (node.kind === 'sticky') {
            const growY = Math.max(0, result.requiredHeight - 200);
            if (growY !== node.growY) followOn = { t: 'set', id, key: 'growY', value: growY };
        } else if (node.kind === 'figure') {
            const growY = Math.max(0, result.requiredHeight + node.width - node.h);
            if (growY !== node.growY) followOn = { t: 'set', id, key: 'growY', value: growY };
        }
        return followOn ? { ...transaction, ops: [...transaction.ops, followOn] } : transaction;
    };
}
