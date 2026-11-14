import type { BoardOp, ExtOp, Op } from '../change/ops';
import { childrenOf, isSheetParent, sheetOf, type BoardDoc, type Sheet } from './doc';
import type { NodeId, ParentId, SheetId } from './ids';
import type { ExtBag } from './json';
import type { MediaEntry, MediaId } from './media';
import { createNode, type ConnectorNode, type Node, type NodeRecord } from './nodes';
import type { OrderKey } from './orderKey';

// Only change/apply.ts imports this module. R-W26: all explicit allocation,
// lookup and planning precede write(). Native Map/Set/splice operations are the
// commit primitives. A throw after the first write is a defect, not a recoverable
// validation error: apply tries its inverses, then seals the session read-only
// (D-10), since it must never serialize a potentially inconsistent document.
export interface PreparedMutation { write(): void }
export class ModelInvariantError extends Error {}
export type ModelOp = Exclude<Op, { readonly t: 'splice' }>;
type MutableDoc = Omit<{ -readonly [K in keyof BoardDoc]: BoardDoc[K] },
    'nodes' | 'sheets' | 'media' | 'sheetOrder' | 'children' | 'attachedTo' | 'bySheet' | 'byPage' | 'mediaRefs' | 'preservedMediaRefs'> & {
    nodes: Map<NodeId, Node>; sheets: Map<SheetId, Sheet>; media: Map<MediaId, MediaEntry>;
    sheetOrder: Sheet[]; children: Map<ParentId, Node[]>;
    attachedTo: Map<NodeId, Set<NodeId>>; bySheet: Map<SheetId, Set<NodeId>>;
    byPage: Map<number, Set<NodeId>>; mediaRefs: Map<MediaId, Set<NodeId>>;
    preservedMediaRefs: Map<MediaId, number>;
};
function forApply(doc: BoardDoc): MutableDoc {
    // Readonly is ownership, not frozen/copied data. Only the apply path writes
    // the same model-owned records/maps that every reader borrows.
    return doc as MutableDoc;
}
function required<T>(value: T | undefined, reason: string): T {
    if (value === undefined) throw new ModelInvariantError(reason);
    return value;
}
function lowerBound(items: readonly { readonly id: string; readonly order: OrderKey }[], id: string, order: OrderKey): number {
    let low = 0, high = items.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const item = items[middle];
        if (item.order < order || (item.order === order && item.id < id)) low = middle + 1;
        else high = middle;
    }
    return low;
}

type IndexKey = NodeId | SheetId | MediaId | number;
interface Bucket {
    readonly index: Map<IndexKey, Set<NodeId>>;
    readonly key: IndexKey;
    readonly members: Set<NodeId>;
    readonly add: NodeId[];
    readonly remove: NodeId[];
}
class MembershipPlan {
    private readonly buckets = new Map<Map<IndexKey, Set<NodeId>>, Map<IndexKey, Bucket>>();
    private readonly ordered: Bucket[] = [];
    change<K extends IndexKey>(index: Map<K, Set<NodeId>>, key: K, id: NodeId, add: boolean): void {
        // Map keys are opaque to the planner; each captured map is only ever
        // accessed with its own K. No mutable index escapes this private plan.
        const map = index as Map<IndexKey, Set<NodeId>>;
        let plans = this.buckets.get(map);
        if (!plans) this.buckets.set(map, plans = new Map());
        let bucket = plans.get(key);
        if (!bucket) {
            bucket = { index: map, key, members: index.get(key) ?? new Set(), add: [], remove: [] };
            plans.set(key, bucket);
            this.ordered.push(bucket);
        }
        (add ? bucket.add : bucket.remove).push(id);
    }
    write(): void {
        for (let i = 0; i < this.ordered.length; i++) {
            const b = this.ordered[i];
            for (let j = 0; j < b.remove.length; j++) b.members.delete(b.remove[j]);
            for (let j = 0; j < b.add.length; j++) b.members.add(b.add[j]);
            if (b.members.size) b.index.set(b.key, b.members);
            else b.index.delete(b.key);
        }
    }
}
function targets(node: ConnectorNode): readonly NodeId[] {
    const start = node.start.attach?.target;
    const end = node.end.attach?.target;
    return start === undefined ? end === undefined ? [] : [end]
        : end === undefined || end === start ? [start] : [start, end];
}
export function nodeMediaForApply(node: Node): readonly MediaId[] {
    if (node.kind === 'picture' || node.kind === 'clip') return node.media === null ? [] : [node.media];
    if (node.kind !== 'linkcard' || !node.preview) return [];
    const image = node.preview.image, favicon = node.preview.favicon;
    return image === null ? favicon === null ? [] : [favicon]
        : favicon === null || favicon === image ? [image] : [image, favicon];
}
function transition<K extends IndexKey>(plan: MembershipPlan, index: Map<K, Set<NodeId>>, id: NodeId, before: readonly K[], after: readonly K[]): void {
    for (let i = 0; i < before.length; i++) if (!after.includes(before[i])) plan.change(index, before[i], id, false);
    for (let i = 0; i < after.length; i++) if (!before.includes(after[i])) plan.change(index, after[i], id, true);
}
function subtreeIds(doc: BoardDoc, id: NodeId, output: NodeId[]): void {
    output.push(id);
    const children = childrenOf(doc, id);
    for (let i = 0; i < children.length; i++) subtreeIds(doc, children[i].id, output);
}
function createNodePlan(doc: MutableDoc, record: NodeRecord): PreparedMutation {
    const node = createNode(record);
    const siblings = doc.children.get(node.parent) ?? [];
    const position = lowerBound(siblings, node.id, node.order);
    const members = new MembershipPlan();
    const sheet = sheetOf(doc, node.parent);
    if (sheet !== undefined) members.change(doc.bySheet, sheet, node.id, true);
    if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) members.change(doc.byPage, node.page, node.id, true);
    if (node.kind === 'connector') transition(members, doc.attachedTo, node.id, [], targets(node));
    transition(members, doc.mediaRefs, node.id, [], nodeMediaForApply(node));
    return { write() {
        doc.nodes.set(node.id, node);
        siblings.splice(position, 0, node);
        doc.children.set(node.parent, siblings);
        members.write();
    } };
}
function deleteNodePlan(doc: MutableDoc, id: NodeId): PreparedMutation {
    const node = required(doc.nodes.get(id), 'Delete target vanished');
    const siblings = required(doc.children.get(node.parent), 'Delete parent index vanished');
    const position = lowerBound(siblings, id, node.order);
    const members = new MembershipPlan();
    const sheet = sheetOf(doc, id);
    if (sheet !== undefined) members.change(doc.bySheet, sheet, id, false);
    if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) members.change(doc.byPage, node.page, id, false);
    if (node.kind === 'connector') transition(members, doc.attachedTo, id, targets(node), []);
    transition(members, doc.mediaRefs, id, nodeMediaForApply(node), []);
    return { write() {
        siblings.splice(position, 1);
        if (siblings.length === 0) doc.children.delete(node.parent);
        members.write();
        // Incoming edges remain discoverable until CH-1 detaches them.
        doc.nodes.delete(id);
    } };
}
function setNodePlan(doc: MutableDoc, op: Extract<Op, { readonly t: 'set' }>, ext: ExtBag | null | undefined): PreparedMutation | undefined {
    const node = required(doc.nodes.get(op.id), 'Set target vanished');
    const changed = !Object.is(Reflect.get(node, op.key), op.value);
    if (!changed && (ext === undefined || ext === node.ext)) return undefined;
    let members: MembershipPlan | undefined;
    let oldSiblings: Node[] | undefined, nextSiblings: Node[] | undefined;
    let oldPosition = -1, nextPosition = -1;
    let nextParent = node.parent;
    if (changed && (op.key === 'parent' || op.key === 'order')) {
        nextParent = op.key === 'parent' ? op.value : node.parent;
        const nextOrder = op.key === 'order' ? op.value : node.order;
        oldSiblings = required(doc.children.get(node.parent), 'Set parent index vanished');
        nextSiblings = doc.children.get(nextParent) ?? [];
        oldPosition = lowerBound(oldSiblings, node.id, node.order);
        nextPosition = lowerBound(nextSiblings, node.id, nextOrder);
        if (oldSiblings === nextSiblings && nextPosition > oldPosition) nextPosition--;
        if (op.key === 'parent') {
            members = new MembershipPlan();
            const before = sheetOf(doc, node.id), after = sheetOf(doc, nextParent);
            if (before !== after) {
                const ids: NodeId[] = [];
                subtreeIds(doc, node.id, ids);
                for (let i = 0; i < ids.length; i++) {
                    if (before !== undefined) members.change(doc.bySheet, before, ids[i], false);
                    if (after !== undefined) members.change(doc.bySheet, after, ids[i], true);
                }
            }
            if (doc.kind !== 'whiteboard') {
                if (isSheetParent(doc, node.parent)) members.change(doc.byPage, node.page, node.id, false);
                if (isSheetParent(doc, nextParent)) members.change(doc.byPage, node.page, node.id, true);
            }
        }
    } else if (changed && op.key === 'page' && doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) {
        members = new MembershipPlan();
        members.change(doc.byPage, node.page, node.id, false);
        members.change(doc.byPage, op.value, node.id, true);
    } else if (changed && (op.key === 'start' || op.key === 'end') && node.kind === 'connector') {
        members = new MembershipPlan();
        const after = { ...node, [op.key]: op.value };
        transition(members, doc.attachedTo, node.id, targets(node), targets(after));
    } else if (changed && (op.key === 'media' || op.key === 'preview')) {
        members = new MembershipPlan();
        const after = { ...node, [op.key]: op.value } as Node;
        transition(members, doc.mediaRefs, node.id, nodeMediaForApply(node), nodeMediaForApply(after));
    }
    const oldParent = node.parent;
    return { write() {
        if (oldSiblings) {
            oldSiblings.splice(oldPosition, 1);
            if (oldSiblings !== nextSiblings && oldSiblings.length === 0) doc.children.delete(oldParent);
        }
        if (changed) Reflect.set(node, op.key, op.value);
        if (ext !== undefined) Reflect.set(node, 'ext', ext);
        if (nextSiblings) {
            nextSiblings.splice(nextPosition, 0, node);
            doc.children.set(nextParent, nextSiblings);
        }
        members?.write();
    } };
}

export function extensionForApply(board: BoardDoc, target: ExtOp['target'], id?: string): ExtBag | null {
    switch (target) {
        case 'node': return required(board.nodes.get(id as NodeId), 'Extension node vanished').ext;
        case 'sheet': return required(board.sheets.get(id as SheetId), 'Extension sheet vanished').ext;
        case 'media': return required(board.media.get(id as MediaId), 'Extension media vanished').ext;
        case 'pen': return board.ui.ext;
        case 'view': return board.view.ext;
        case 'paper':
            if (board.host.kind !== 'notebook') throw new ModelInvariantError('Expected notebook paper');
            return board.host.ext;
        case 'host':
            if (board.host.kind !== 'pdf-ink') throw new ModelInvariantError('Expected PDF host');
            return board.host.ext;
    }
}
function extPlan(doc: MutableDoc, op: ExtOp): PreparedMutation | undefined {
    if (extensionForApply(doc, op.target, op.id) === op.value) return undefined;
    switch (op.target) {
        case 'node': { const node = required(doc.nodes.get(op.id as NodeId), 'Extension node vanished'); return { write() { Reflect.set(node, 'ext', op.value); } }; }
        case 'sheet': { const sheet = required(doc.sheets.get(op.id as SheetId), 'Extension sheet vanished'); return { write() { Reflect.set(sheet, 'ext', op.value); } }; }
        case 'media': {
            const id = op.id as MediaId;
            const next = { ...required(doc.media.get(id), 'Extension media vanished'), ext: op.value };
            return { write() { doc.media.set(id, next); } };
        }
        case 'pen': { const next = { ...doc.ui, ext: op.value }; return { write() { doc.ui = next; } }; }
        case 'view': { const next = { ...doc.view, ext: op.value }; return { write() { doc.view = next; } }; }
        case 'paper': case 'host': {
            if (doc.host.kind === 'whiteboard') throw new ModelInvariantError('Expected paper/PDF host');
            const next = { ...doc.host, ext: op.value };
            return { write() { doc.host = next; } };
        }
    }
}
function boardPlan(doc: MutableDoc, op: BoardOp, ext: ExtBag | null | undefined): PreparedMutation | undefined {
    if (op.key === 'host.paper') {
        if (doc.host.kind !== 'notebook') throw new ModelInvariantError('Expected notebook paper');
        if (doc.host.paper === op.value && (ext === undefined || ext === doc.host.ext)) return undefined;
        const next = { kind: 'notebook' as const, paper: op.value, ext: ext === undefined ? doc.host.ext : ext };
        return { write() { doc.host = next; } };
    }
    if (op.key === 'host.pdf') {
        if (doc.host.kind !== 'pdf-ink') throw new ModelInvariantError('Expected PDF host');
        if (doc.host.pdf === op.value && (ext === undefined || ext === doc.host.ext)) return undefined;
        const next = { kind: 'pdf-ink' as const, pdf: op.value, pages: doc.host.pages, ext: ext === undefined ? doc.host.ext : ext };
        return { write() { doc.host = next; } };
    }
    switch (op.key) {
        case 'ui.tool': case 'ui.next': case 'ui.penWidth': {
            const key = op.key === 'ui.tool' ? 'tool' : op.key === 'ui.next' ? 'next' : 'penWidth';
            if (Object.is(doc.ui[key], op.value) && (ext === undefined || ext === doc.ui.ext)) return undefined;
            const next = { ...doc.ui, [key]: op.value, ext: ext === undefined ? doc.ui.ext : ext };
            return { write() { doc.ui = next; } };
        }
        default: {
            const key = op.key.slice(5) as keyof Omit<BoardDoc['view'], 'ext'>;
            if (doc.view[key] === op.value && (ext === undefined || ext === doc.view.ext)) return undefined;
            const next = { ...doc.view, [key]: op.value, ext: ext === undefined ? doc.view.ext : ext };
            return { write() { doc.view = next; } };
        }
    }
}

export function prepareMutationForApply(board: BoardDoc, op: ModelOp, extAfter?: ExtBag | null): PreparedMutation | undefined {
    const doc = forApply(board);
    switch (op.t) {
        case 'create': return createNodePlan(doc, op.node);
        case 'delete': return deleteNodePlan(doc, op.id);
        case 'set': return setNodePlan(doc, op, extAfter);
        case 'ext': return extPlan(doc, op);
        case 'board': return boardPlan(doc, op, extAfter);
        case 'media':
            if (op.op === 'add') { const entry = op.entry; return { write() { doc.media.set(entry.id, entry); } }; }
            required(doc.media.get(op.id), 'Media drop target vanished');
            return { write() { doc.media.delete(op.id); } };
        case 'sheet':
            if (op.op === 'create') {
                const record = op.sheet;
                const sheet = { id: record.id, name: record.name, order: record.order, ext: record.ext };
                const position = lowerBound(doc.sheetOrder, sheet.id, sheet.order);
                return { write() { doc.sheets.set(sheet.id, sheet); doc.sheetOrder.splice(position, 0, sheet); } };
            } else if (op.op === 'delete') {
                const sheet = required(doc.sheets.get(op.id), 'Sheet delete target vanished');
                const position = lowerBound(doc.sheetOrder, sheet.id, sheet.order);
                return { write() { doc.sheetOrder.splice(position, 1); doc.sheets.delete(op.id); doc.bySheet.delete(op.id); } };
            } else {
                const sheet = required(doc.sheets.get(op.id), 'Sheet set target vanished');
                if (sheet[op.key] === op.value && (extAfter === undefined || extAfter === sheet.ext)) return undefined;
                const position = op.key === 'order' ? lowerBound(doc.sheetOrder, sheet.id, sheet.order) : -1;
                const rawNext = op.key === 'order' ? lowerBound(doc.sheetOrder, sheet.id, op.value) : -1;
                const next = rawNext > position ? rawNext - 1 : rawNext;
                return { write() {
                    if (position >= 0) doc.sheetOrder.splice(position, 1);
                    Reflect.set(sheet, op.key, op.value);
                    if (extAfter !== undefined) Reflect.set(sheet, 'ext', extAfter);
                    if (position >= 0) doc.sheetOrder.splice(next, 0, sheet);
                } };
            }
    }
}

export function preparePreservedCountsForApply(board: BoardDoc, delta: ReadonlyMap<MediaId, number>): PreparedMutation | undefined {
    if (delta.size === 0) return undefined;
    const counts = forApply(board).preservedMediaRefs;
    const next: [MediaId, number][] = [];
    for (const [id, change] of delta) {
        if (change === 0) continue;
        const value = (counts.get(id) ?? 0) + change;
        if (!Number.isSafeInteger(value) || value < 0) throw new ModelInvariantError('Preserved media reference count underflow/overflow');
        next.push([id, value]);
    }
    return { write() {
        for (let i = 0; i < next.length; i++) {
            const [id, count] = next[i];
            if (count === 0) counts.delete(id);
            else counts.set(id, count);
        }
    } };
}
export function prepareRevisionForApply(board: BoardDoc, revision: number): PreparedMutation {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ModelInvariantError('Invalid document revision');
    const doc = forApply(board);
    return { write() { doc.rev = revision; } };
}
