import type { BoardOp, BoardValue, NodeSetOp, PropValue } from '../change/ops';
import { childrenOf, isSheetParent, sheetOf, type BoardDoc, type Sheet } from './doc';
import type { NodeId, ParentId, SheetId } from './ids';
import type { MediaEntry, MediaId } from './media';
import { createNode, type ConnectorNode, type Node, type NodeRecord } from './nodes';
import { compareOrder } from './orderKey';

// DM-2: only change/apply may import this module. These helpers assume validated
// ops and maintain indexes; they do not validate, normalize, record or notify.
type MutableDoc = Omit<{ -readonly [K in keyof BoardDoc]: BoardDoc[K] },
    'nodes' | 'sheets' | 'media' | 'sheetOrder' | 'children' | 'attachedTo' | 'bySheet' | 'byPage'> & {
    nodes: Map<NodeId, Node>;
    sheets: Map<SheetId, Sheet>;
    media: Map<MediaId, MediaEntry>;
    sheetOrder: Sheet[];
    children: Map<ParentId, Node[]>;
    attachedTo: Map<NodeId, Set<NodeId>>;
    bySheet: Map<SheetId, Set<NodeId>>;
    byPage: Map<number, Set<NodeId>>;
};

function forApply(doc: BoardDoc): MutableDoc {
    // Readonly expresses ownership, not frozen/copied data. The model constructs
    // these same objects/maps; the apply path is their only runtime writer.
    return doc as MutableDoc;
}

function lowerBound<T extends { readonly id: string; readonly order: string }>(items: readonly T[], value: T): number {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (compareOrder(items[middle], value) < 0) low = middle + 1;
        else high = middle;
    }
    return low;
}

function addChild(doc: MutableDoc, node: Node): void {
    let siblings = doc.children.get(node.parent);
    if (!siblings) doc.children.set(node.parent, siblings = []);
    siblings.splice(lowerBound(siblings, node), 0, node);
}

function removeChild(doc: MutableDoc, node: Node): void {
    const siblings = doc.children.get(node.parent)!;
    siblings.splice(lowerBound(siblings, node), 1);
    if (siblings.length === 0) doc.children.delete(node.parent);
}

function addMember<K>(index: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    let members = index.get(key);
    if (!members) index.set(key, members = new Set());
    members.add(id);
}

function removeMember<K>(index: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    const members = index.get(key);
    if (!members) return;
    members.delete(id);
    if (members.size === 0) index.delete(key);
}

function addAttachments(doc: MutableDoc, node: ConnectorNode): void {
    if (node.start.attach) addMember(doc.attachedTo, node.start.attach.target, node.id);
    if (node.end.attach) addMember(doc.attachedTo, node.end.attach.target, node.id);
}

function removeAttachments(doc: MutableDoc, node: ConnectorNode): void {
    if (node.start.attach) removeMember(doc.attachedTo, node.start.attach.target, node.id);
    if (node.end.attach) removeMember(doc.attachedTo, node.end.attach.target, node.id);
}

function moveSubtreeSheet(doc: MutableDoc, id: NodeId, before: SheetId | undefined, after: SheetId | undefined): void {
    if (before !== undefined) removeMember(doc.bySheet, before, id);
    if (after !== undefined) addMember(doc.bySheet, after, id);
    const children = childrenOf(doc, id);
    for (let i = 0; i < children.length; i++) moveSubtreeSheet(doc, children[i].id, before, after);
}

export function insertNodeForApply(board: BoardDoc, record: NodeRecord): Node {
    const doc = forApply(board);
    const node = createNode(record);
    doc.nodes.set(node.id, node);
    addChild(doc, node);
    const sheet = sheetOf(doc, node.id);
    if (sheet !== undefined) addMember(doc.bySheet, sheet, node.id);
    if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) addMember(doc.byPage, node.page, node.id);
    if (node.kind === 'connector') addAttachments(doc, node);
    return node;
}

// The command/apply validator requires a leaf deletion; subtree expansion is CH-1.
export function removeNodeForApply(board: BoardDoc, id: NodeId): NodeRecord {
    const doc = forApply(board);
    const node = doc.nodes.get(id)!;
    const sheet = sheetOf(doc, id);
    removeChild(doc, node);
    if (sheet !== undefined) removeMember(doc.bySheet, sheet, id);
    if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) removeMember(doc.byPage, node.page, id);
    if (node.kind === 'connector') removeAttachments(doc, node);
    // Inbound attachments stay indexed until normalization detaches their ends.
    // Deleting this entry now would hide the connectors the apply path must visit.
    doc.nodes.delete(id);
    return node;
}

export function setNodeFieldForApply(board: BoardDoc, op: NodeSetOp): PropValue {
    const doc = forApply(board);
    const node = doc.nodes.get(op.id)!;
    const previous: PropValue = Reflect.get(node, op.key);
    if (Object.is(previous, op.value)) return previous;
    // The validator has matched the key/value to this kind. Reflect writes the
    // existing field in place without publishing a mutable Node type to consumers.
    switch (op.key) {
        case 'parent': {
            const before = sheetOf(doc, node.id);
            removeChild(doc, node);
            if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) removeMember(doc.byPage, node.page, node.id);
            Reflect.set(node, op.key, op.value);
            addChild(doc, node);
            if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) addMember(doc.byPage, node.page, node.id);
            const after = sheetOf(doc, node.id);
            if (before !== after) moveSubtreeSheet(doc, node.id, before, after);
            break;
        }
        case 'order':
            removeChild(doc, node);
            Reflect.set(node, op.key, op.value);
            addChild(doc, node);
            break;
        case 'page':
            if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) removeMember(doc.byPage, node.page, node.id);
            Reflect.set(node, op.key, op.value);
            if (doc.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) addMember(doc.byPage, node.page, node.id);
            break;
        case 'start':
        case 'end':
            if (node.kind === 'connector') removeAttachments(doc, node);
            Reflect.set(node, op.key, op.value);
            if (node.kind === 'connector') addAttachments(doc, node);
            break;
        default:
            Reflect.set(node, op.key, op.value);
    }
    return previous;
}

export function insertSheetForApply(board: BoardDoc, record: Sheet): Sheet {
    const doc = forApply(board);
    const sheet = { id: record.id, name: record.name, order: record.order, ext: record.ext };
    doc.sheets.set(sheet.id, sheet);
    doc.sheetOrder.splice(lowerBound(doc.sheetOrder, sheet), 0, sheet);
    return sheet;
}

export function removeSheetForApply(board: BoardDoc, id: SheetId): Sheet {
    const doc = forApply(board);
    const sheet = doc.sheets.get(id)!;
    doc.sheetOrder.splice(lowerBound(doc.sheetOrder, sheet), 1);
    doc.sheets.delete(id);
    doc.bySheet.delete(id);
    return sheet;
}

export function setSheetFieldForApply(board: BoardDoc, id: SheetId, key: 'name' | 'order', value: string): string {
    const doc = forApply(board);
    const sheet = doc.sheets.get(id)!;
    const previous = sheet[key];
    if (previous === value) return previous;
    if (key === 'order') doc.sheetOrder.splice(lowerBound(doc.sheetOrder, sheet), 1);
    Reflect.set(sheet, key, value);
    if (key === 'order') doc.sheetOrder.splice(lowerBound(doc.sheetOrder, sheet), 0, sheet);
    return previous;
}

export function addMediaForApply(board: BoardDoc, entry: MediaEntry): void {
    forApply(board).media.set(entry.id, entry);
}

export function dropMediaForApply(board: BoardDoc, id: MediaId): MediaEntry {
    const doc = forApply(board);
    const entry = doc.media.get(id)!;
    doc.media.delete(id);
    return entry;
}

export function setBoardFieldForApply(board: BoardDoc, op: BoardOp): BoardValue {
    const doc = forApply(board);
    switch (op.key) {
        case 'host.paper': {
            if (doc.host.kind !== 'notebook') throw new Error('Apply expected notebook paper');
            const previous = doc.host.paper;
            doc.host = { kind: 'notebook', paper: op.value, ext: doc.host.ext };
            return previous;
        }
        case 'host.pdf': {
            if (doc.host.kind !== 'pdf-ink') throw new Error('Apply expected PDF bookkeeping');
            const previous = doc.host.pdf;
            doc.host = { kind: 'pdf-ink', pdf: op.value, pages: doc.host.pages };
            return previous;
        }
        case 'ui.tool': {
            const previous = doc.ui.tool;
            doc.ui = { ...doc.ui, tool: op.value };
            return previous;
        }
        case 'ui.next': {
            const previous = doc.ui.next;
            doc.ui = { ...doc.ui, next: op.value };
            return previous;
        }
        case 'ui.penWidth': {
            const previous = doc.ui.penWidth;
            doc.ui = { ...doc.ui, penWidth: op.value };
            return previous;
        }
        case 'view.grid': {
            const previous = doc.view.grid;
            doc.view = { ...doc.view, grid: op.value };
            return previous;
        }
        case 'view.focusMode': {
            const previous = doc.view.focusMode;
            doc.view = { ...doc.view, focusMode: op.value };
            return previous;
        }
        case 'view.toolLock': {
            const previous = doc.view.toolLock;
            doc.view = { ...doc.view, toolLock: op.value };
            return previous;
        }
        case 'view.transparent': {
            const previous = doc.view.transparent;
            doc.view = { ...doc.view, transparent: op.value };
            return previous;
        }
        case 'view.debugMode': {
            const previous = doc.view.debugMode;
            doc.view = { ...doc.view, debugMode: op.value };
            return previous;
        }
    }
}

export function setRevisionForApply(board: BoardDoc, revision: number): void {
    forApply(board).rev = revision;
}
