import type { BoardKind, Sheet } from './doc';
import { isValidId, type NodeId, type ParentId, type SheetId } from './ids';
import type { NodeRecord } from './nodes';
import { isValidKey, keysBetween } from './orderKey';
import type { LoadRepairNotice } from './loadTypes';

export interface GraphRepairOptions {
    readonly kind: BoardKind;
    readonly sheets: readonly Sheet[];
    readonly nodes: readonly NodeRecord[];
    readonly newId: () => string;
    readonly rootPlacement: (node: NodeRecord, sheet: SheetId, ordinal: number) => { readonly page: number; readonly x: number; readonly y: number };
    readonly cooperate?: () => Promise<void>;
    readonly signal?: AbortSignal;
}
export interface GraphRepairResult {
    readonly nodes: readonly NodeRecord[];
    readonly changedOrdinals: ReadonlySet<number>;
    readonly notices: readonly LoadRepairNotice[];
    readonly readOnlyReason: string | null;
}
interface Item { node: NodeRecord; readonly ordinal: number }

/** Ordered load-only graph repair. Opaque records are never rewritten: if repair
 * would require that, the original bytes remain authoritative and the host opens
 * read-only. Source ordinals tell the line cache which records need re-encoding. */
export async function repairGraph(options: GraphRepairOptions): Promise<GraphRepairResult> {
    const changed = new Set<number>(), messages = new Map<string, string[]>();
    const record = (item: Item, code: string) => {
        changed.add(item.ordinal);
        const ids = messages.get(code);
        if (ids) ids.push(item.node.id); else messages.set(code, [item.node.id]);
    };
    const result = (items: readonly Item[], reason: string | null): GraphRepairResult => ({
        nodes: items.map(item => item.node), changedOrdinals: changed,
        notices: [...messages].map(([code, nodeIds]) => ({ code, count: nodeIds.length, nodeIds })), readOnlyReason: reason,
    });
    const sheets = new Set<ParentId>(options.sheets.map(sheet => sheet.id));
    if (!options.sheets.length) return result([], 'The board has no sheet');
    const root = options.sheets[0].id, items: Item[] = [];
    const reserved = new Set<string>([...sheets, ...options.nodes.map(node => node.id)]);
    const byId = new Map<NodeId, Item>();
    const tick = async (index: number) => {
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
        if ((index & 1023) === 0 && options.cooperate) await options.cooperate();
    };
    for (let i = 0; i < options.nodes.length; i++) {
        await tick(i);
        let node = options.nodes[i];
        if (!isValidId(node.id) || byId.has(node.id) || sheets.has(node.id)) {
            if (node.kind === 'opaque') return result(items, 'An opaque record has a duplicate or invalid identity');
            let id = '';
            for (let attempt = 0; attempt < 1024; attempt++) {
                const candidate = options.newId();
                if (isValidId(candidate) && !reserved.has(candidate)) { id = candidate; break; }
            }
            if (!id) return result(items, 'Cannot allocate a unique node identity');
            reserved.add(id);
            node = { ...node, id: id as NodeId };
            const item = { node, ordinal: i }; items.push(item); byId.set(node.id, item); record(item, 'duplicate-id');
        } else { const item = { node, ordinal: i }; items.push(item); byId.set(node.id, item); }
    }
    let refusal: string | null = null;
    const makeRoot = (item: Item, reason: string) => {
        if (item.node.kind === 'opaque') { refusal = 'Repair would move an opaque record'; return; }
        const pos = options.kind === 'whiteboard' ? { page: -1, x: item.node.x, y: item.node.y }
            : options.rootPlacement(item.node, root, item.ordinal);
        item.node = { ...item.node, parent: root, ...pos };
        record(item, reason);
    };
    const done = new Set<NodeId>();
    for (let i = 0; i < items.length; i++) {
        await tick(i);
        let item: Item | undefined = items[i];
        if (done.has(item.node.id)) continue;
        const path: Item[] = [], positions = new Map<NodeId, number>();
        while (item && !done.has(item.node.id)) {
            const at = positions.get(item.node.id);
            if (at !== undefined) {
                let smallest = path[at];
                for (let j = at + 1; j < path.length; j++) if (path[j].node.id < smallest.node.id) smallest = path[j];
                makeRoot(smallest, 'cycle'); break;
            }
            positions.set(item.node.id, path.length); path.push(item);
            if (path.length > 64) { refusal = 'Container nesting exceeds 64'; break; }
            if (sheets.has(item.node.parent)) break;
            const parent = byId.get(item.node.parent as NodeId);
            if (!parent || (parent.node.kind !== 'group' && parent.node.kind !== 'frame')) { makeRoot(item, 'missing-parent'); break; }
            item = parent;
        }
        if (refusal) return result(items, refusal);
        for (const member of path) done.add(member.node.id);
    }
    // A cached depth is needed even when a path terminates at a previously
    // visited ancestor: otherwise a long chain admitted in parent-first order
    // incorrectly passes the per-path depth limit.
    const depths = new Map<NodeId, number>();
    for (let i = 0; i < items.length; i++) {
        await tick(i);
        const path: Item[] = []; let item: Item | undefined = items[i];
        while (item && !depths.has(item.node.id)) { path.push(item); item = byId.get(item.node.parent as NodeId); }
        let depth = item ? depths.get(item.node.id)! : 0;
        for (let j = path.length - 1; j >= 0; j--) {
            depth++;
            if (depth > 64) return result(items, 'Container nesting exceeds 64');
            depths.set(path[j].node.id, depth);
        }
    }
    const children = new Map<ParentId, Item[]>();
    for (const item of items) {
        const list = children.get(item.node.parent);
        if (list) list.push(item); else children.set(item.node.parent, [item]);
    }
    for (const list of children.values()) {
        let bad = false;
        const seen = new Set<string>();
        for (let i = 0; i < list.length; i++) {
            const order = list[i].node.order;
            if (!isValidKey(order) || seen.has(order)) { bad = true; break; }
            seen.add(order);
        }
        if (!bad) continue;
        if (list.some(item => item.node.kind === 'opaque')) return result(items, 'Repairing order would change an opaque record');
        const keys = keysBetween(null, null, list.length);
        for (let i = 0; i < list.length; i++) {
            list[i].node = { ...list[i].node, order: keys[i] };
            record(list[i], 'order');
        }
    }
    return result(items, null);
}
