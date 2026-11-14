import type { NotebookPaper } from '../../utils/paper';
import type { NodeId, ParentId, SheetId } from './ids';
import type { ExtBag, RawJson } from './json';
import type { MediaEntry, MediaId, MediaTable } from './media';
import { createNode, type Node, type NodeRecord, type NodeTable } from './nodes';
import { compareOrder, type OrderKey } from './orderKey';
import type { UiBlock } from './styles';

// document-model.md §§1/6, M-1/M-6: pages and paper are host data, never nodes.
export type BoardKind = 'whiteboard' | 'notebook' | 'pdf-ink';
export interface Sheet {
    readonly id: SheetId;
    readonly name: string;
    readonly order: OrderKey;
    readonly ext: ExtBag | null;
}
export type SheetTable = ReadonlyMap<SheetId, Sheet>;

export interface ViewFlags {
    readonly grid: boolean;
    readonly focusMode: boolean;
    readonly toolLock: boolean;
    readonly transparent: boolean;
    readonly debugMode: boolean;
    readonly ext: ExtBag | null;
}

// R-W5 (contracts C2.2 v4.5): the PDF writer owns this opaque bookkeeping.
export type HostBlock =
    | { readonly kind: 'whiteboard' }
    | { readonly kind: 'notebook'; readonly paper: Readonly<NotebookPaper>; readonly ext: ExtBag | null }
    | { readonly kind: 'pdf-ink'; readonly pdf: RawJson; readonly pages: readonly (readonly [number, number])[]; readonly ext: ExtBag | null };

// R-W17: unknown header fields and whole records retain their source lexemes.
export interface PreservedBlock {
    readonly version: readonly [number, number];
    readonly fields: ReadonlyMap<string, RawJson>;
    readonly records: readonly { readonly type: string; readonly id: string; readonly raw: RawJson }[];
    readonly end: ExtBag | null; // R-W30: unknown end-record fields, never its derived count.
}

// Consumers read the live tables by reference (M-10). Only the model's apply path
// writes them; readonly reaches nested values so a scene cannot mutate an attachment.
export interface BoardDoc {
    readonly kind: BoardKind;
    readonly sheets: SheetTable;
    readonly nodes: NodeTable;
    readonly media: MediaTable;
    readonly sheetOrder: readonly Sheet[];
    readonly children: ReadonlyMap<ParentId, readonly Node[]>;
    readonly attachedTo: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
    readonly bySheet: ReadonlyMap<SheetId, ReadonlySet<NodeId>>;
    readonly byPage: ReadonlyMap<number, ReadonlySet<NodeId>>; // Paged root nodes only; all sheets.
    readonly mediaRefs: ReadonlyMap<MediaId, ReadonlySet<NodeId>>;
    readonly preservedMediaRefs: ReadonlyMap<MediaId, number>;
    readonly ui: UiBlock;
    readonly view: ViewFlags;
    readonly host: HostBlock;
    readonly preserved: PreservedBlock;
    readonly rev: number; // Session-local; never persisted.
}

export interface BoardDocInput {
    readonly kind: BoardKind;
    readonly sheets: Iterable<Sheet>;
    readonly nodes?: Iterable<NodeRecord>;
    readonly media?: Iterable<MediaEntry>;
    readonly ui: UiBlock;
    readonly view: ViewFlags;
    readonly host: HostBlock;
    readonly preserved: PreservedBlock;
    readonly preservedMediaRefs: ReadonlyMap<MediaId, number>; // Reader counts only RawJson retained in the model (R-W25).
}

const EMPTY_CHILDREN: readonly Node[] = Object.freeze([]);
// RV-22 asks whether a subtree is opaque, not for a mutable index. Strict
// descendant counts are private to model; zero entries are absent. A million-node
// frame under a one-child group must not be walked just to answer this guard.
type OpaqueIndexedDoc = BoardDoc & { readonly opaqueDescendants: ReadonlyMap<ParentId, number> };
export function hasOpaqueDescendant(doc: BoardDoc, parent: ParentId): boolean {
    return ((doc as OpaqueIndexedDoc).opaqueDescendants.get(parent) ?? 0) > 0;
}

export function childrenOf(doc: BoardDoc, parent: ParentId): readonly Node[] {
    return doc.children.get(parent) ?? EMPTY_CHILDREN;
}

export function isSheetParent(doc: BoardDoc, parent: ParentId): parent is SheetId {
    return doc.sheets.has(parent as SheetId);
}

export function sheetOf(doc: BoardDoc, id: ParentId): SheetId | undefined {
    let current = id;
    // Valid documents reach a sheet within 64 links (V-2). This read is also safe
    // while a loader is assembling a document; it never diagnoses or repairs it.
    for (let depth = 0; depth <= 64; depth++) {
        if (isSheetParent(doc, current)) return current;
        const node = doc.nodes.get(current);
        if (!node) return undefined;
        current = node.parent;
    }
    return undefined;
}

// A stable callback sees the actual node objects in paint order, not a sorted copy
// or a per-node iterator allocation. Frames/groups precede their children.
export function forEachNodeInZOrder(doc: BoardDoc, sheet: SheetId, visit: (node: Node) => void): void {
    visitChildren(doc, sheet, visit);
}

function visitChildren(doc: BoardDoc, parent: ParentId, visit: (node: Node) => void): void {
    const children = childrenOf(doc, parent);
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        visit(node);
        visitChildren(doc, node.id, visit);
    }
}

function addMember<K>(index: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    let members = index.get(key);
    if (!members) index.set(key, members = new Set());
    members.add(id);
}

// DM-2: callers supply validated/repaired records. Loading builds indexes only;
// runtime document edits use model/applyOnly.ts, never this creation path.
export function createBoardDoc(input: BoardDocInput): BoardDoc {
    const sheets = new Map<SheetId, Sheet>();
    const nodes = new Map<NodeId, Node>();
    const media = new Map<MediaId, MediaEntry>();
    const sheetOrder: Sheet[] = [];
    const children = new Map<ParentId, Node[]>();
    const attachedTo = new Map<NodeId, Set<NodeId>>();
    const bySheet = new Map<SheetId, Set<NodeId>>();
    const byPage = new Map<number, Set<NodeId>>();
    const mediaRefs = new Map<MediaId, Set<NodeId>>();
    const preservedMediaRefs = new Map(input.preservedMediaRefs);
    const opaqueDescendants = new Map<ParentId, number>();
    const doc: OpaqueIndexedDoc = {
        kind: input.kind, sheets, nodes, media, sheetOrder, children, attachedTo, bySheet, byPage, mediaRefs, preservedMediaRefs, opaqueDescendants,
        ui: input.ui, view: input.view, host: input.host, preserved: input.preserved, rev: 0,
    };
    for (const record of input.sheets) {
        const sheet = { id: record.id, name: record.name, order: record.order, ext: record.ext };
        sheets.set(sheet.id, sheet);
        sheetOrder.push(sheet);
    }
    sheetOrder.sort(compareOrder);
    for (const record of input.nodes ?? []) {
        const node = createNode(record);
        nodes.set(node.id, node);
        let siblings = children.get(node.parent);
        if (!siblings) children.set(node.parent, siblings = []);
        siblings.push(node);
    }
    // A 1M-record file may be id-sorted, not paint-sorted. Repeated binary inserts
    // would still memmove O(n²) references on load; bulk-sort once, never on a read.
    for (const siblings of children.values()) siblings.sort(compareOrder);
    for (const node of nodes.values()) {
        const sheet = sheetOf(doc, node.id);
        if (sheet !== undefined) addMember(bySheet, sheet, node.id);
        if (input.kind !== 'whiteboard' && isSheetParent(doc, node.parent)) addMember(byPage, node.page, node.id);
        if (node.kind === 'opaque') {
            let parent = node.parent;
            for (let depth = 0; depth <= 64; depth++) {
                opaqueDescendants.set(parent, (opaqueDescendants.get(parent) ?? 0) + 1);
                if (isSheetParent(doc, parent)) break;
                const container = nodes.get(parent);
                if (!container) break;
                parent = container.parent;
            }
        }
        if (node.kind === 'connector') {
            if (node.start.attach) addMember(attachedTo, node.start.attach.target, node.id);
            if (node.end.attach) addMember(attachedTo, node.end.attach.target, node.id);
        }
        if ((node.kind === 'picture' || node.kind === 'clip') && node.media) addMember(mediaRefs, node.media, node.id);
        if (node.kind === 'linkcard' && node.preview) {
            if (node.preview.image) addMember(mediaRefs, node.preview.image, node.id);
            if (node.preview.favicon) addMember(mediaRefs, node.preview.favicon, node.id);
        }
    }
    for (const entry of input.media ?? []) media.set(entry.id, entry);
    return doc;
}
