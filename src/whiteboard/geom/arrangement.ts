import { isLocked } from '../change/commands';
import type { Op, Transaction, TransactionOrigin } from '../change/ops';
import { isSheetParent } from '../model/doc';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { align, distribute, pack, stack, stretch } from './arrange';
import type { ArrangeItem, ArrangeMove, Axis } from './arrange';
import type { ArrangementAction, ArrangementServices, StretchServices } from './arrangement.types';
import { ResizePlan } from './resizePlan';
import { commonResizeRotation } from './transforms';
import { TranslationPlan } from './translation';

function rootItems(doc: BoardDoc, selected: readonly NodeId[], services: ArrangementServices): ArrangeItem[] {
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
    return items;
}
export function arrangementTransaction(doc: BoardDoc, selected: readonly NodeId[], action: ArrangementAction,
    services: ArrangementServices, origin: TransactionOrigin = 'tool'): Transaction {
    const items = rootItems(doc, selected, services);
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

export function stretchTransaction(doc: BoardDoc, selected: readonly NodeId[], axis: Axis,
    services: StretchServices, origin: TransactionOrigin = 'tool'): Transaction {
    const items = rootItems(doc, selected, services), targets = stretch(items, axis), ops: Op[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i], node = doc.nodes.get(item.id)!;
        const oldExtent = axis === 'horizontal' ? item.bounds.width : item.bounds.height;
        if (!(oldExtent > 0)) throw new RangeError('Cannot stretch a zero-extent selection');
        const factor = targets[i].extent / oldExtent, targetCentre = targets[i].origin + targets[i].extent / 2;
        const snapshot = services.resize.capture(node);
        const rotations = snapshot.relevantRotations.length ? snapshot.relevantRotations : [snapshot.worldRotation];
        const angle = commonResizeRotation(rotations) ?? 0;
        const axisAligned = commonResizeRotation([0, angle]) !== null;
        const swapped = Math.abs(Math.round(angle / (Math.PI / 2)) % 2) === 1;
        const localX = axisAligned ? (axis === 'horizontal') !== swapped : true;
        const base = services.resize;
        let correction = 0;
        const plan = new ResizePlan([node], { x: 0, y: 0 }, localX ? { x: 1, y: 0 } : { x: 0, y: 1 }, {
            kinds: base.kinds, capture: value => base.capture(value), isCurrent: () => base.isCurrent(),
            place: (value, centre, patch) => base.place(value, axis === 'horizontal' ? { x: centre.x + correction, y: centre.y } : { x: centre.x, y: centre.y + correction }, patch),
        }, items.length > 1 ? 'multi' : 'single');
        const frame = plan.startBox, c = Math.cos(frame.rotation), s = Math.sin(frame.rotation);
        const pivotX = frame.origin.x + c * frame.width / 2 - s * frame.height / 2;
        const pivotY = frame.origin.y + s * frame.width / 2 + c * frame.height / 2;
        const oldCentre = axis === 'horizontal' ? item.bounds.x + item.bounds.width / 2 : item.bounds.y + item.bounds.height / 2;
        const pivot = axis === 'horizontal' ? pivotX : pivotY;
        correction = targetCentre - (pivot + (oldCentre - pivot) * factor);
        const dx = localX ? frame.width * (factor - 1) / 2 : 0, dy = localX ? 0 : frame.height * (factor - 1) / 2;
        ops.push(...plan.preview({ x: c * dx - s * dy, y: s * dx + c * dy }, { alt: true, shift: !axisAligned }).ops);
    }
    return { origin, label: `Stretch ${axis}`, ops };
}
