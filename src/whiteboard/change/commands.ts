import { childrenOf, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { compareOrder, keysBetween, needsRekey, type OrderKey } from '../model/orderKey';
import type { CommandBuilder, Op, OpSink } from './ops';
import { ApplyRefused, refuseChange } from './errors';
import { poseInParent, worldPose, type ChangeGeometry, type LocalPose } from './coordinates';

function command<T>(builder: CommandBuilder, run: () => T): T {
    const point = builder.savepoint();
    try { return run(); }
    catch (error) {
        if (error instanceof ApplyRefused) builder.rollbackTo(point);
        else builder.abort();
        throw error;
    }
}
export function isLocked(doc: BoardDoc, node: Node): boolean {
    let current: Node | undefined = node;
    for (let depth = 0; current && depth <= 64; depth++) {
        if (current.locked) return true;
        current = doc.nodes.get(current.parent);
    }
    return false;
}
function selectedRoots(doc: BoardDoc, ids: Iterable<NodeId>): Node[] {
    const selected = new Set(ids), roots: Node[] = [];
    for (const id of selected) {
        const node = doc.nodes.get(id);
        if (!node) refuseChange('V-1', 'Node does not exist', id);
        let parent = node.parent, covered = false;
        for (let depth = 0; depth <= 64 && !isSheetParent(doc, parent); depth++) {
            if (selected.has(parent)) { covered = true; break; }
            const ancestor = doc.nodes.get(parent);
            if (!ancestor) refuseChange('V-2', 'Parent does not exist', id);
            parent = ancestor.parent;
        }
        if (!covered) roots.push(node);
    }
    const left: Node[] = [], right: Node[] = [];
    const path = (node: Node, output: Node[]) => {
        output.length = 0;
        for (let depth = 0; depth <= 64; depth++) {
            output.push(node);
            const parent = doc.nodes.get(node.parent);
            if (!parent) return;
            node = parent;
        }
    };
    roots.sort((a, b) => {
        if (a.id === b.id) return 0;
        path(a, left); path(b, right);
        const aSheet = doc.sheets.get(left[left.length - 1].parent as SheetId)!;
        const bSheet = doc.sheets.get(right[right.length - 1].parent as SheetId)!;
        if (aSheet.id !== bSheet.id) return compareOrder(aSheet, bSheet);
        let i = left.length - 1, j = right.length - 1;
        while (i >= 0 && j >= 0 && left[i].id === right[j].id) { i--; j--; }
        return i < 0 ? -1 : j < 0 ? 1 : compareOrder(left[i], right[j]);
    });
    return roots;
}
export function setIfChanged<K extends 'x' | 'y' | 'rotation' | 'page' | 'opacity' | 'order' | 'locked'>(builder: OpSink, node: Node, key: K, value: Node[K]): void {
    if (Object.is(node[key], value)) return;
    builder.push({ t: 'set', id: node.id, key, value } as Op);
}
function applyPlacement(builder: OpSink, node: Node, parent: ParentId, local: LocalPose, order?: OrderKey): void {
    if (node.parent !== parent) builder.push({ t: 'set', id: node.id, key: 'parent', value: parent });
    setIfChanged(builder, node, 'page', local.page);
    setIfChanged(builder, node, 'x', local.x);
    setIfChanged(builder, node, 'y', local.y);
    setIfChanged(builder, node, 'rotation', local.rotation);
    if (order !== undefined) setIfChanged(builder, node, 'order', order);
}
// The normalization sink is private to commit; public commands add their own
// savepoint, while normalization is covered by the whole transaction's rollback.
export function stageReparent(doc: BoardDoc, sink: OpSink, node: Node, parent: ParentId, geometry?: ChangeGeometry, order?: OrderKey): void {
    if (node.kind === 'opaque') refuseChange('opaque', 'Opaque nodes cannot be reparented', node.id);
    const local = poseInParent(doc, node, parent, worldPose(doc, node.id), geometry);
    applyPlacement(sink, node, parent, local, order);
}
export function reparentNode(doc: BoardDoc, builder: CommandBuilder, node: Node, parent: ParentId, geometry?: ChangeGeometry, order?: OrderKey): void {
    command(builder, () => stageReparent(doc, builder, node, parent, geometry, order));
}

// Opaque siblings are fixed pins (RV-22). Re-key each intervening interval,
// preserving its paint order; refuse BEFORE changing anything if no short keys
// fit without moving a pin. Imported pin keys themselves remain verbatim.
export function rekeyParent(doc: BoardDoc, builder: OpSink, parent: ParentId): void {
    const siblings = childrenOf(doc, parent), ops: Op[] = [];
    let lower: OrderKey | null = null, start = 0;
    for (let i = 0; i <= siblings.length; i++) {
        if (i < siblings.length && siblings[i].kind !== 'opaque') continue;
        const upper = i < siblings.length ? siblings[i].order : null;
        if (i > start) {
            if (lower !== null && upper !== null && lower >= upper) refuseChange('opaque', 'Cannot re-key between fixed opaque nodes');
            const keys = keysBetween(lower, upper, i - start);
            for (let j = start; j < i; j++) {
                const order = keys[j - start];
                if (needsRekey(order)) refuseChange('opaque', 'Short order keys require moving an opaque node', siblings[j].id);
                if (siblings[j].order !== order) ops.push({ t: 'set', id: siblings[j].id, key: 'order', value: order });
            }
        }
        lower = upper;
        start = i + 1;
    }
    for (const op of ops) builder.push(op);
}
export function rekeySheets(doc: BoardDoc, builder: OpSink): void {
    const keys = keysBetween(null, null, doc.sheetOrder.length);
    // Capture IDs first: each push reorders the live sheetOrder array.
    const ops: Op[] = [];
    for (let i = 0; i < keys.length; i++) {
        const sheet = doc.sheetOrder[i];
        if (sheet.order !== keys[i]) ops.push({ t: 'sheet', op: 'set', id: sheet.id, key: 'order', value: keys[i] });
    }
    for (const op of ops) builder.push(op);
}
export function allocateOrderKeys(doc: BoardDoc, builder: CommandBuilder, parent: ParentId,
    lowerId: NodeId | null, upperId: NodeId | null, count: number): readonly OrderKey[] {
    return command(builder, () => {
        const bound = (id: NodeId | null): OrderKey | null => {
            if (id === null) return null;
            const node = doc.nodes.get(id);
            if (!node || node.parent !== parent) refuseChange('V-3', 'Order bound is not a sibling', id);
            return node.order;
        };
        let lower = bound(lowerId), upper = bound(upperId);
        let keys = lower !== null && upper !== null && lower >= upper ? null : keysBetween(lower, upper, count);
        if (!keys || keys.some(needsRekey)) {
            rekeyParent(doc, builder, parent);
            lower = bound(lowerId); upper = bound(upperId);
            if (lower !== null && upper !== null && lower >= upper) refuseChange('V-3', 'Order bounds cannot be separated');
            keys = keysBetween(lower, upper, count);
            if (keys.some(needsRekey)) refuseChange('V-3', 'Short order keys cannot be allocated');
        }
        return keys;
    });
}

export interface DeleteResult {
    readonly deleted: readonly NodeId[];
    readonly kept: readonly NodeId[];
    readonly notes: readonly string[];
}
interface KeptNode { readonly node: Node; readonly parent: ParentId; readonly local: LocalPose; readonly opacity: number }
interface DeleteRoot { readonly root: Node; readonly kept: readonly KeptNode[]; readonly removed: readonly NodeId[] }
export function deleteNodes(doc: BoardDoc, builder: CommandBuilder, ids: Iterable<NodeId>, geometry?: ChangeGeometry): DeleteResult {
    return command(builder, () => {
        const plans: DeleteRoot[] = [], kept: NodeId[] = [], deleted: NodeId[] = [];
        // Analyze the whole command before the first push, notably opaque guards
        // and geometry. A later refusal still has the builder savepoint as backup.
        for (const root of selectedRoots(doc, ids)) {
            if (root.kind === 'opaque') refuseChange('opaque', 'Opaque nodes cannot be deleted', root.id);
            if (isLocked(doc, root)) { kept.push(root.id); continue; }
            const retained: KeptNode[] = [], removed: NodeId[] = [];
            const visit = (node: Node, opacity: number) => {
                if (node.kind === 'opaque') refuseChange('opaque', 'Deleting this container would reparent an opaque node', node.id);
                if (node.locked) {
                    retained.push({ node, parent: root.parent,
                        local: poseInParent(doc, node, root.parent, worldPose(doc, node.id), geometry),
                        opacity: opacity * node.opacity });
                    return;
                }
                const children = childrenOf(doc, node.id);
                for (let i = 0; i < children.length; i++) visit(children[i], opacity * node.opacity);
                removed.push(node.id);
            };
            visit(root, 1);
            plans.push({ root, kept: retained, removed });
        }
        for (const plan of plans) {
            const siblings = childrenOf(doc, plan.root.parent);
            const position = siblings.findIndex(node => node.id === plan.root.id);
            const lower = position > 0 ? siblings[position - 1].id : null;
            const upper = position + 1 < siblings.length ? siblings[position + 1].id : null;
            const keys = plan.kept.length ? allocateOrderKeys(doc, builder, plan.root.parent, lower, upper, plan.kept.length) : [];
            for (let i = 0; i < plan.kept.length; i++) {
                const item = plan.kept[i];
                applyPlacement(builder, item.node, item.parent, item.local, keys[i]);
                setIfChanged(builder, item.node, 'opacity', item.opacity);
                kept.push(item.node.id);
            }
            for (const id of plan.removed) { builder.push({ t: 'delete', id }); deleted.push(id); }
        }
        return { deleted, kept, notes: kept.map(id => `kept locked ${id}`) };
    });
}

export function moveNodesToSheet(doc: BoardDoc, builder: CommandBuilder, ids: Iterable<NodeId>, target: SheetId, geometry?: ChangeGeometry): readonly NodeId[] {
    return command(builder, () => {
        if (!doc.sheets.has(target)) refuseChange('V-1', 'Destination sheet does not exist');
        const roots = selectedRoots(doc, ids), moved: NodeId[] = [];
        // Same-sheet selection is a no-op, not an accidental ungroup command.
        const plans = roots.filter(node => sheetOf(doc, node.id) !== target).map(node => {
            if (node.kind === 'opaque') refuseChange('opaque', 'Opaque nodes cannot be moved to another sheet', node.id);
            if (isLocked(doc, node)) refuseChange('schema', 'Locked nodes cannot be moved', node.id);
            return { node, local: poseInParent(doc, node, target, worldPose(doc, node.id), geometry) };
        });
        const siblings = childrenOf(doc, target);
        const keys = allocateOrderKeys(doc, builder, target, siblings.length ? siblings[siblings.length - 1].id : null, null, plans.length);
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            applyPlacement(builder, plan.node, target, plan.local, keys[i]);
            moved.push(plan.node.id);
        }
        return moved;
    });
}
