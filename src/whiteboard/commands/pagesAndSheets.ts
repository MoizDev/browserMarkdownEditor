import type { ApplyController } from '../change/apply';
import type { Applied, BoardOp, Op } from '../change/ops';
import { PAGE_GAP } from '../../platform/render/pageStack';
import { MAX_PAGES, paperPageSize, type NotebookPaper } from '../../utils/paper';
import { childrenOf, type BoardDoc } from '../model/doc';
import { newNodeId, type NodeId, type SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { deleteNodes } from '../change/commands';
import type { ChangeGeometry } from '../change/coordinates';
import type { ExtBag } from '../model/json';
import { keyBetween } from '../model/orderKey';

type MutationPort = Pick<ApplyController, 'apply' | 'begin'>;

/** A refusal is safe to show in the host's own dialog. */
export class StructureRefused extends Error {
    constructor(message: string) { super(message); this.name = 'StructureRefused'; }
}

function commit(apply: MutationPort, label: string, ops: Op[]): Applied {
    return apply.apply({ origin: 'host', label, ops });
}

export function addSheet(doc: BoardDoc, apply: MutationPort, id: SheetId, name: string): Applied {
    if (doc.sheetOrder.length >= 40) throw new StructureRefused('Maximum pages reached');
    const last = doc.sheetOrder.at(-1);
    return commit(apply, 'Create sheet', [{ t: 'sheet', op: 'create', sheet: {
        id, name, order: keyBetween(last?.order ?? null, null), ext: null,
    } }]);
}

function withoutRaw(ext: ExtBag | null, keys: readonly string[]): ExtBag | null {
    if (!ext) return null;
    const raw = new Map(ext.raw);
    for (const key of keys) raw.delete(key);
    return { fields: ext.fields, raw };
}

export function duplicateSheet(doc: BoardDoc, apply: MutationPort, source: SheetId, id: SheetId, name?: string): Applied {
    if (doc.sheetOrder.length >= 40) throw new StructureRefused('Maximum pages reached');
    const index = doc.sheetOrder.findIndex(sheet => sheet.id === source);
    if (index < 0) throw new StructureRefused('Sheet no longer exists');
    const original = doc.sheetOrder[index];
    const allocated = new Set<NodeId>();
    const tables = { nodes: { has: (node: NodeId) => allocated.has(node) || doc.nodes.has(node) }, sheets: doc.sheets };
    const nodes: Node[] = [];
    const ids = new Map<NodeId, NodeId>();
    const visit = (node: Node) => {
        if (node.kind === 'opaque') throw new StructureRefused('Unsupported content cannot be duplicated safely');
        let copy: NodeId;
        do { copy = newNodeId(tables); } while (copy === id as unknown as NodeId);
        allocated.add(copy); ids.set(node.id, copy); nodes.push(node);
        for (const child of childrenOf(doc, node.id)) visit(child);
    };
    for (const node of childrenOf(doc, source)) visit(node);
    const ops: Op[] = [{ t: 'sheet', op: 'create', sheet: { id, name: name ?? `${original.name.slice(0, 195)} Copy`,
        order: keyBetween(original.order, doc.sheetOrder[index + 1]?.order ?? null),
        ext: withoutRaw(original.ext, ['id', 'name', 'order']) } }];
    for (const node of nodes) {
        const parent = node.parent === source ? id : ids.get(node.parent as NodeId);
        if (!parent) throw new StructureRefused('Content parent cannot be duplicated safely');
        if (node.kind === 'opaque') throw new StructureRefused('Unsupported content cannot be duplicated safely');
        if (node.kind === 'connector') {
            const remap = (end: typeof node.start) => {
                if (!end.attach) return end;
                const target = ids.get(end.attach.target);
                if (!target) throw new StructureRefused('Connector target cannot be duplicated safely');
                return { ...end, attach: { ...end.attach, target } };
            };
            ops.push({ t: 'create', node: { ...node, id: ids.get(node.id)!, parent, start: remap(node.start), end: remap(node.end),
                ext: withoutRaw(node.ext, ['id', 'parent', 'start', 'end']) } });
        } else ops.push({ t: 'create', node: { ...node, id: ids.get(node.id)!, parent, ext: withoutRaw(node.ext, ['id', 'parent']) } });
    }
    return commit(apply, 'Duplicate sheet', ops);
}

export function renameSheet(apply: MutationPort, id: SheetId, name: string): Applied {
    return commit(apply, 'Rename sheet', [{ t: 'sheet', op: 'set', id, key: 'name', value: name }]);
}

/** Destination is an index in the resulting sheet order, not the original list. */
export function reorderSheet(doc: BoardDoc, apply: MutationPort, id: SheetId, destination: number): Applied | undefined {
    const old = doc.sheetOrder.findIndex(sheet => sheet.id === id);
    if (old < 0 || !Number.isInteger(destination) || destination < 0 || destination >= doc.sheetOrder.length)
        throw new StructureRefused('Invalid sheet or destination');
    if (old === destination) return undefined;
    const rest = doc.sheetOrder.filter(sheet => sheet.id !== id);
    return commit(apply, 'Reorder sheet', [{ t: 'sheet', op: 'set', id, key: 'order',
        value: keyBetween(rest[destination - 1]?.order ?? null, rest[destination]?.order ?? null) }]);
}

/** Returns the exact descendants to disclose before a destructive confirmation. */
export function deletionContents(doc: BoardDoc, roots: readonly NodeId[]): readonly Node[] {
    const result: Node[] = [], seen = new Set<NodeId>();
    const visit = (id: NodeId) => {
        if (seen.has(id)) return;
        const node = doc.nodes.get(id);
        if (!node) throw new StructureRefused('Content no longer exists');
        seen.add(id);
        if (node.locked) throw new StructureRefused('Locked or unsupported content cannot be deleted');
        for (const child of childrenOf(doc, id)) visit(child.id);
        result.push(node);
    };
    for (const id of roots) visit(id);
    return result;
}

export function deleteSheet(doc: BoardDoc, apply: MutationPort, id: SheetId): Applied {
    if (!doc.sheets.has(id)) throw new StructureRefused('Sheet no longer exists');
    if (doc.sheets.size <= 1) throw new StructureRefused('A board must keep one sheet');
    const contents = deletionContents(doc, childrenOf(doc, id).map(node => node.id));
    return commit(apply, 'Delete sheet', [...contents.map((node): Op => ({ t: 'delete', id: node.id })),
        { t: 'sheet', op: 'delete', id }]);
}

function notebook(doc: BoardDoc) {
    if (doc.host.kind !== 'notebook') throw new StructureRefused('Physical pages can only be edited in a notebook');
    return doc.host.paper;
}

export function addPage(doc: BoardDoc, apply: MutationPort): Applied {
    const paper = notebook(doc);
    if (paper.pageCount >= MAX_PAGES) throw new StructureRefused('Maximum pages reached');
    return commit(apply, 'Add page', [{ t: 'board', key: 'host.paper', value: { ...paper, pageCount: paper.pageCount + 1 } }]);
}

export function changePaper(doc: BoardDoc, apply: MutationPort, paper: Readonly<NotebookPaper>): Applied {
    notebook(doc);
    return commit(apply, 'Change paper', [{ t: 'board', key: 'host.paper', value: paper }]);
}

/** Append this operation to the originating content transaction, not a later save. */
export function notebookGrowthOp(doc: BoardDoc, deepestWorldY: number): BoardOp | undefined {
    const paper = notebook(doc);
    if (!Number.isFinite(deepestWorldY)) throw new StructureRefused('Invalid content bounds');
    const { height } = paperPageSize(paper);
    const threshold = (paper.pageCount - 1) * (height + PAGE_GAP) + 0.8 * height;
    if (deepestWorldY < threshold || paper.pageCount >= MAX_PAGES) return undefined;
    const extra = Math.max(1, Math.ceil((deepestWorldY - threshold) / (height + PAGE_GAP)));
    return { t: 'board', key: 'host.paper', value: { ...paper, pageCount: Math.min(MAX_PAGES, paper.pageCount + extra) } };
}

const NODE_NAMES: Record<Node['kind'], readonly [string, string]> = {
    stroke: ['stroke', 'strokes'], figure: ['shape', 'shapes'], text: ['text', 'texts'],
    sticky: ['sticky note', 'sticky notes'], connector: ['arrow', 'arrows'], polyline: ['line', 'lines'],
    frame: ['frame', 'frames'], group: ['group', 'groups'], picture: ['picture', 'pictures'],
    clip: ['video', 'videos'], linkcard: ['bookmark', 'bookmarks'], embed: ['embed', 'embeds'],
    opaque: ['unsupported item', 'unsupported items'],
};

/** Structured counts let the host pluralize actual kinds, not call every item a stroke (WB-D29). */
export function pageContentCounts(contents: readonly Node[]): ReadonlyMap<Node['kind'], number> {
    const counts = new Map<Node['kind'], number>();
    for (const node of contents) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return counts;
}

export function describePageContents(contents: readonly Node[]): string {
    return [...pageContentCounts(contents)].map(([kind, count]) => `${count} ${NODE_NAMES[kind][count === 1 ? 0 : 1]}`).join(', ');
}

export function lastPageContents(doc: BoardDoc): readonly Node[] {
    const paper = notebook(doc);
    if (paper.pageCount <= 1) throw new StructureRefused('A notebook must keep one page');
    const contents: Node[] = [];
    const visit = (id: NodeId) => {
        const node = doc.nodes.get(id);
        if (!node) throw new StructureRefused('Content no longer exists');
        if (node.kind === 'opaque') throw new StructureRefused(`Unsupported item ${id} prevents page deletion`);
        if (node.locked) return;
        for (const child of childrenOf(doc, id)) visit(child.id);
        contents.push(node);
    };
    for (const id of doc.byPage.get(paper.pageCount - 1) ?? []) {
        if (doc.nodes.get(id)?.kind !== 'opaque') visit(id);
    }
    return contents;
}

export function deleteLastPage(doc: BoardDoc, apply: MutationPort, geometry?: ChangeGeometry): Applied {
    const paper = notebook(doc);
    if (paper.pageCount <= 1) throw new StructureRefused('A notebook must keep one page');
    const roots = [...(doc.byPage.get(paper.pageCount - 1) ?? [])].filter(id => doc.nodes.get(id)?.kind !== 'opaque');
    const builder = apply.begin('host', 'Delete page');
    try {
        deleteNodes(doc, builder, roots, geometry);
        builder.push({ t: 'board', key: 'host.paper', value: { ...paper, pageCount: paper.pageCount - 1 } });
        return builder.commit();
    } catch (error) {
        builder.abort();
        throw error;
    }
}

/** Reorders physical pages while preserving each root's unscaled page-local position. */
export function reorderPage(doc: BoardDoc, apply: MutationPort, from: number, to: number): Applied | undefined {
    const { pageCount } = notebook(doc);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= pageCount || to >= pageCount)
        throw new StructureRefused('Invalid page or destination');
    if (from === to) return undefined;
    const ops: Op[] = [];
    for (let page = Math.min(from, to); page <= Math.max(from, to); page++) {
        const next = page === from ? to : page + (from < to ? -1 : 1);
        for (const id of doc.byPage.get(page) ?? []) {
            const node = doc.nodes.get(id);
            if (!node) throw new StructureRefused('Content no longer exists');
            if (node.kind === 'opaque') throw new StructureRefused(`Unsupported item ${id} prevents reordering`);
            ops.push({ t: 'set', id, key: 'page', value: next });
        }
    }
    // Empty pages are indistinguishable and have no persisted identity.
    return ops.length ? commit(apply, 'Reorder pages', ops) : undefined;
}
