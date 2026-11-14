import type { BoardKind, Sheet } from './doc';
import { isValidId, type NodeId, type ParentId, type SheetId } from './ids';
import type { NodeRecord } from './nodes';
import { isValidKey, keyBetween } from './orderKey';
import { NODE_FILE_FIELDS } from './fileFields';
import type { LoadRepairNotice } from './loadTypes';
import type { RawJson } from './json';

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
    readonly sourceOrdinals: readonly number[];
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
        nodes: items.map(item => item.node), sourceOrdinals: items.map(item => item.ordinal), changedOrdinals: changed,
        notices: [...messages].map(([code, nodeIds]) => ({ code, count: nodeIds.length, nodeIds })), readOnlyReason: reason,
    });
    const sheets = new Set<ParentId>(options.sheets.map(sheet => sheet.id));
    if (!options.sheets.length) return result([], 'The board has no sheet');
    const root = options.sheets[0].id, items: Item[] = [];
    const reserved = new Set<string>(sheets);
    const byId = new Map<NodeId, Item>();
    const tick = async () => {
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
        if (options.cooperate) await options.cooperate();
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
    };
    for (let i = 0; i < options.nodes.length; i++) {
        if ((i & 1023) === 0) await tick();
        reserved.add(options.nodes[i].id);
    }
    for (let i = 0; i < options.nodes.length; i++) {
        if ((i & 1023) === 0) await tick();
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
            const fields = new Map(node.ext?.fields);
            // Existing user metadata wins; the generated JSON string is inert and valid by construction.
            if (!fields.has('importedId')) fields.set('importedId', JSON.stringify(node.id) as RawJson);
            node = { ...node, id: id as NodeId, ext: { fields, raw: node.ext?.raw ?? new Map() } };
            const item = { node, ordinal: i }; items.push(item); byId.set(node.id, item); record(item, 'duplicate-id');
        } else { const item = { node, ordinal: i }; items.push(item); byId.set(node.id, item); }
    }
    let refusal: string | null = null;
    const makeRoot = (item: Item, reason: string) => {
        if (item.node.kind === 'opaque') { refusal = 'Repair would move an opaque record'; return; }
        if (['parent', 'page', 'x', 'y'].some(key => NODE_FILE_FIELDS[key as 'parent' | 'page' | 'x' | 'y'].some(token => item.node.ext?.raw.has(token)))) {
            refusal = 'Repair would override preserved node properties'; return;
        }
        const pos = options.kind === 'whiteboard' ? { page: -1, x: item.node.x, y: item.node.y }
            : options.rootPlacement(item.node, root, item.ordinal);
        item.node = { ...item.node, parent: root, ...pos };
        record(item, reason);
    };
    const done = new Set<NodeId>();
    for (let i = 0; i < items.length; i++) {
        if ((i & 1023) === 0) await tick();
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
    for (let i = 0; i < items.length; i++) {
        if ((i & 255) === 0) await tick();
        const item = items[i], rootNode = sheets.has(item.node.parent);
        const nested = options.kind === 'whiteboard' || !rootNode;
        if (nested ? item.node.page === -1 : Number.isSafeInteger(item.node.page) && item.node.page >= 0) continue;
        if (item.node.kind === 'opaque' || NODE_FILE_FIELDS.page.some(token => item.node.ext?.raw.has(token))) {
            return result(items, 'Page repair would override an opaque or preserved record');
        }
        if (nested) item.node = { ...item.node, page: -1 };
        else {
            if (['x', 'y'].some(key => NODE_FILE_FIELDS[key as 'x' | 'y'].some(token => item.node.ext?.raw.has(token)))) {
                return result(items, 'Page repair would override preserved placement');
            }
            item.node = { ...item.node, ...options.rootPlacement(item.node, item.node.parent as SheetId, item.ordinal) };
        }
        record(item, 'page');
    }
    // A cached depth is needed even when a path terminates at a previously
    // visited ancestor: otherwise a long chain admitted in parent-first order
    // incorrectly passes the per-path depth limit.
    const depths = new Map<NodeId, number>();
    for (let i = 0; i < items.length; i++) {
        if ((i & 1023) === 0) await tick();
        const path: Item[] = []; let item: Item | undefined = items[i];
        while (item && !depths.has(item.node.id)) { path.push(item); item = byId.get(item.node.parent as NodeId); }
        let depth = item ? depths.get(item.node.id)! : 0;
        for (let j = path.length - 1; j >= 0; j--) {
            depth++;
            if (depth > 64) return result(items, 'Container nesting exceeds 64');
            depths.set(path[j].node.id, depth);
        }
    }
    // Set insertion order is file order here; later dissolution only needs membership.
    const children = new Map<ParentId, Set<Item>>();
    let work = 0;
    for (const item of items) {
        if ((work++ & 1023) === 0) await tick();
        let bucket = children.get(item.node.parent);
        if (!bucket) children.set(item.node.parent, bucket = new Set());
        bucket.add(item);
    }
    for (const bucket of children.values()) {
        if ((work++ & 1023) === 0) await tick();
        let bad = false, protectedOrder = false;
        const seen = new Set<string>();
        for (const item of bucket) {
            if ((work++ & 1023) === 0) await tick();
            const order = item.node.order;
            if (!isValidKey(order) || seen.has(order)) bad = true;
            seen.add(order);
            if (item.node.kind === 'opaque' || NODE_FILE_FIELDS.order.some(token => item.node.ext?.raw.has(token))) protectedOrder = true;
        }
        if (!bad) continue;
        if (protectedOrder) return result(items, 'Repairing order would change an opaque or preserved record');
        let previous: string | null = null;
        for (const item of bucket) {
            if ((work++ & 1023) === 0) await tick();
            previous = keyBetween(previous, null);
            item.node = { ...item.node, order: previous };
            record(item, 'order');
        }
    }
    // Build parent buckets once; a chain of dissolving groups is linear rather
    // than rescanning every node on each removal. An opaque descendant pins all
    // of its ancestors: its byte-preserved parent cannot be rewritten.
    const opaqueAncestors = new Set<ParentId>();
    for (const item of items) {
        if ((work++ & 1023) === 0) await tick();
        if (item.node.kind !== 'opaque') continue;
        let parent = item.node.parent;
        for (let depth = 0; depth <= 64; depth++) {
            if ((work++ & 1023) === 0) await tick();
            opaqueAncestors.add(parent);
            const ancestor = byId.get(parent as NodeId);
            if (!ancestor) break;
            parent = ancestor.node.parent;
        }
    }
    const live = new Set<NodeId>(), groups: NodeId[] = [];
    for (const item of items) {
        if ((work++ & 1023) === 0) await tick();
        live.add(item.node.id);
        if (item.node.kind === 'group') groups.push(item.node.id);
    }
    for (let index = 0; index < groups.length; index++) {
        if ((index & 1023) === 0) await tick();
        const item = byId.get(groups[index]);
        if (!item || !live.has(item.node.id) || item.node.kind !== 'group' || opaqueAncestors.has(item.node.id)) continue;
        const group = item.node;
        const direct = children.get(group.id);
        if (direct && direct.size >= 2) continue;
        const child = direct?.values().next().value;
        // Removing unknown group fields or silently overriding preserved raw
        // child properties would destroy newer-format content. Keep original.
        if (group.ext && (group.ext.fields.size || group.ext.raw.size)) return result(items, 'A group with preserved metadata cannot be dissolved safely');
        if (child?.node.ext?.raw.size) return result(items, 'A group child has preserved properties that prevent safe dissolution');
        const parentChildren = children.get(group.parent);
        if (child) {
            if (child.node.kind === 'opaque') return result(items, 'Repair would move an opaque record');
            const c = Math.cos(group.rotation), s = Math.sin(group.rotation);
            const angle = (group.rotation + child.node.rotation) % (Math.PI * 2);
            child.node = { ...child.node, parent: group.parent, order: group.order,
                x: group.x + c * child.node.x - s * child.node.y,
                y: group.y + s * child.node.x + c * child.node.y,
                rotation: angle < 0 ? angle + Math.PI * 2 : angle,
                page: sheets.has(group.parent) ? group.page : -1,
                opacity: group.opacity * child.node.opacity,
                locked: group.locked || child.node.locked };
            record(child, 'dissolved-group-child');
        }
        if (parentChildren?.delete(item) && child) parentChildren.add(child);
        live.delete(group.id); children.delete(group.id);
        record(item, 'dissolved-group');
        const parent = byId.get(group.parent as NodeId);
        if (parent?.node.kind === 'group') groups.push(parent.node.id);
    }
    const sheetCache = new Map<NodeId, ParentId | null>();
    const sheetFor = (item: Item): ParentId | null => {
        const path: NodeId[] = [];
        let current: Item | undefined = item, sheet: ParentId | null = null;
        while (current) {
            if (sheetCache.has(current.node.id)) { sheet = sheetCache.get(current.node.id)!; break; }
            path.push(current.node.id);
            if (sheets.has(current.node.parent)) { sheet = current.node.parent; break; }
            current = byId.get(current.node.parent as NodeId);
        }
        for (const id of path) sheetCache.set(id, sheet);
        return sheet;
    };
    for (let i = 0; i < items.length; i++) {
        if ((i & 1023) === 0) await tick();
        const item = items[i], node = item.node;
        if (!live.has(node.id) || node.kind !== 'connector') continue;
        const sheet = sheetFor(item);
        const detach = (end: typeof node.start) => {
            if (!end.attach) return end;
            const target = byId.get(end.attach.target);
            if (target && live.has(target.node.id) && target.node.id !== node.id && target.node.kind !== 'connector'
                && target.node.kind !== 'group' && target.node.kind !== 'opaque' && sheet !== null && sheetFor(target) === sheet) return end;
            return { x: end.x, y: end.y, attach: null };
        };
        const start = detach(node.start), end = detach(node.end);
        if (start !== node.start || end !== node.end) {
            if ((start !== node.start && NODE_FILE_FIELDS.start.some(token => node.ext?.raw.has(token)))
                || (end !== node.end && NODE_FILE_FIELDS.end.some(token => node.ext?.raw.has(token)))) return result(items, 'Repair would override a preserved connector endpoint');
            item.node = { ...node, start, end }; record(item, 'detached-attachment');
        }
    }
    const retained: Item[] = [];
    for (const item of items) {
        if ((work++ & 1023) === 0) await tick();
        if (live.has(item.node.id)) retained.push(item);
    }
    return result(retained, null);
}
