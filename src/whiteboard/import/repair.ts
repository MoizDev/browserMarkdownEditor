import type { BoardKind, Sheet } from '../model/doc';
import { nodeId, type NodeId, type ParentId } from '../model/ids';
import type { Node } from '../model/nodes';
import { isValidKey, keysBetween } from '../model/orderKey';
import { ReportBuilder } from './report';

export interface RootPosition { readonly page: number; readonly x: number; readonly y: number }
export type RootMapper = (node: Node) => RootPosition;

// M-11: repair is a load-only draft transformation, never an edit transaction.
export function repairLegacyTree(records: readonly Node[], sheets: readonly Sheet[], kind: BoardKind,
    rootPosition: RootMapper, report: ReportBuilder): readonly Node[] {
    if (!sheets.length) throw new Error('Cannot repair without a sheet');
    const root = sheets[0].id;
    const sheetIds = new Set<ParentId>(sheets.map(sheet => sheet.id));
    const nodes = new Map<NodeId, Node>();
    const reserved = new Set<ParentId>([...sheetIds, ...records.map(node => node.id)]);
    const order: NodeId[] = [];
    let serial = 0;
    for (const original of records) {
        let node = original;
        if (nodes.has(node.id) || sheetIds.has(node.id)) {
            let replacement: NodeId;
            do { replacement = nodeId(`${original.id.slice(0, 100)}~dup${++serial}`); }
            while (reserved.has(replacement));
            reserved.add(replacement);
            node = { ...original, id: replacement };
            report.repair(original.id, `Duplicate identifier renamed to ${replacement}`);
        }
        nodes.set(node.id, node); order.push(node.id);
    }
    function makeRoot(node: Node, reason: string): void {
        const pos = kind === 'whiteboard' ? { page: -1, x: node.x, y: node.y } : rootPosition(node);
        nodes.set(node.id, { ...node, parent: root, ...pos });
        report.repair(node.id, reason);
    }
    // Resolve each path once; a three-state walk detects cycles without recursion on hostile depth.
    const done = new Set<NodeId>();
    for (const id of order) {
        if (done.has(id)) continue;
        const path: NodeId[] = [], at = new Map<NodeId, number>();
        let current: NodeId | undefined = id;
        while (current && !done.has(current)) {
            const repeated = at.get(current);
            if (repeated !== undefined) {
                const cycle = path.slice(repeated).sort();
                makeRoot(nodes.get(cycle[0])!, 'Cyclic parent repaired');
                break;
            }
            const node = nodes.get(current);
            if (!node) break;
            at.set(current, path.length); path.push(current);
            if (path.length > 64) { report.refuse(id, 'Container nesting exceeds 64'); break; }
            if (sheetIds.has(node.parent)) break;
            const parent = nodes.get(node.parent as NodeId);
            if (!parent || (parent.kind !== 'group' && parent.kind !== 'frame')) {
                makeRoot(node, 'Missing or invalid parent repaired'); break;
            }
            current = parent.id;
        }
        for (const entry of path) done.add(entry);
    }
    const childIds = new Map<ParentId, Set<NodeId>>();
    for (const node of nodes.values()) {
        let children = childIds.get(node.parent);
        if (!children) childIds.set(node.parent, children = new Set());
        children.add(node.id);
    }
    const queue = order.filter(id => nodes.get(id)?.kind === 'group');
    while (queue.length) {
        const id = queue.pop()!, group = nodes.get(id);
        if (!group || group.kind !== 'group') continue;
        const children = childIds.get(id);
        if ((children?.size ?? 0) >= 2) continue;
        const parentChildren = childIds.get(group.parent);
        parentChildren?.delete(id);
        const childId = children?.values().next().value as NodeId | undefined;
        if (childId !== undefined) {
            const child = nodes.get(childId)!;
            const c = Math.cos(group.rotation), s = Math.sin(group.rotation);
            const rotation = ((group.rotation + child.rotation) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
            nodes.set(childId, { ...child, parent: group.parent, order: group.order, page: group.page,
                x: group.x + c * child.x - s * child.y, y: group.y + s * child.x + c * child.y, rotation });
            parentChildren?.add(childId);
        }
        nodes.delete(id); childIds.delete(id);
        report.repair(id, childId === undefined ? 'Empty group removed' : 'Single-child group dissolved');
        const parent = nodes.get(group.parent as NodeId);
        if (parent?.kind === 'group') queue.push(parent.id);
    }
    function sheetFor(node: Node): ParentId | null {
        let parent = node.parent;
        for (let depth = 0; depth <= 64; depth++) {
            if (sheetIds.has(parent)) return parent;
            const ancestor = nodes.get(parent as NodeId);
            if (!ancestor) return null;
            parent = ancestor.parent;
        }
        return null;
    }
    for (const node of nodes.values()) {
        if (node.kind !== 'connector') continue;
        const sheet = sheetFor(node);
        const repairEnd = (end: typeof node.start) => {
            if (!end.attach) return end;
            const target = nodes.get(end.attach.target);
            if (target && target.id !== node.id && target.kind !== 'connector' && target.kind !== 'group'
                && target.kind !== 'opaque' && sheet !== null && sheetFor(target) === sheet) return end;
            report.repair(node.id, 'Invalid connector attachment detached');
            return { x: end.x, y: end.y, attach: null };
        };
        const start = repairEnd(node.start), end = repairEnd(node.end);
        if (start !== node.start || end !== node.end) nodes.set(node.id, { ...node, start, end });
    }
    const siblings = new Map<ParentId, Node[]>();
    for (const id of order) {
        const node = nodes.get(id);
        if (!node) continue;
        const list = siblings.get(node.parent) ?? [];
        if (!siblings.has(node.parent)) siblings.set(node.parent, list);
        list.push(node);
    }
    for (const list of siblings.values()) {
        if (list.every(node => isValidKey(node.order))) continue;
        list.sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const keys = keysBetween(null, null, list.length);
        list.forEach((node, index) => nodes.set(node.id, { ...node, order: keys[index] }));
        report.repair(null, 'Invalid sibling order keys regenerated');
    }
    return order.flatMap(id => { const node = nodes.get(id); return node ? [node] : []; });
}
