import type { ApplyController } from '../change/apply';
import type { Applied, Op } from '../change/ops';
import { childrenOf, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { ConnectorEnd, ConnectorNode, Node, Point } from '../model/nodes';
import { keyBetween } from '../model/orderKey';

/** A refusal is safe to show in the host's own dialog. */
export class StructureRefused extends Error {
    constructor(message: string) { super(message); this.name = 'StructureRefused'; }
}

export type ResolveConnectorEnd = (connector: ConnectorNode, end: 'start' | 'end') => Point;

function commit(apply: ApplyController, label: string, ops: Op[]): Applied {
    return apply.apply({ origin: 'host', label, ops });
}

export function addSheet(doc: BoardDoc, apply: ApplyController, id: SheetId, name: string): Applied {
    if (doc.sheetOrder.length >= 40) throw new StructureRefused('Maximum pages reached');
    const last = doc.sheetOrder.at(-1);
    return commit(apply, 'Create sheet', [{ t: 'sheet', op: 'create', sheet: {
        id, name, order: keyBetween(last?.order ?? null, null), ext: null,
    } }]);
}

export function renameSheet(apply: ApplyController, id: SheetId, name: string): Applied {
    return commit(apply, 'Rename sheet', [{ t: 'sheet', op: 'set', id, key: 'name', value: name }]);
}

/** Destination is an index in the resulting sheet order, not the original list. */
export function reorderSheet(doc: BoardDoc, apply: ApplyController, id: SheetId, destination: number): Applied | undefined {
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

function deletionOps(doc: BoardDoc, contents: readonly Node[], resolve?: ResolveConnectorEnd): Op[] {
    const removed = new Set(contents.map(node => node.id));
    const connectors = new Set<NodeId>();
    for (const id of removed) for (const connector of doc.attachedTo.get(id) ?? []) connectors.add(connector);
    const ops: Op[] = [];
    for (const id of connectors) {
        if (removed.has(id)) continue;
        const node = doc.nodes.get(id);
        if (!node || node.kind !== 'connector') continue;
        for (const key of ['start', 'end'] as const) {
            const end = node[key];
            if (!end.attach || !removed.has(end.attach.target)) continue;
            if (node.locked || !resolve) throw new StructureRefused('A protected or unresolved connector prevents deletion');
            const point = resolve(node, key);
            const value: ConnectorEnd = { ...point, attach: null };
            ops.push({ t: 'set', id, key, value });
        }
    }
    for (const node of contents) ops.push({ t: 'delete', id: node.id });
    return ops;
}

export function deleteSheet(doc: BoardDoc, apply: ApplyController, id: SheetId, resolve?: ResolveConnectorEnd): Applied {
    if (!doc.sheets.has(id)) throw new StructureRefused('Sheet no longer exists');
    if (doc.sheets.size <= 1) throw new StructureRefused('A board must keep one sheet');
    const contents = deletionContents(doc, childrenOf(doc, id).map(node => node.id));
    return commit(apply, 'Delete sheet', [...deletionOps(doc, contents, resolve), { t: 'sheet', op: 'delete', id }]);
}

function notebook(doc: BoardDoc) {
    if (doc.host.kind !== 'notebook') throw new StructureRefused('Physical pages can only be edited in a notebook');
    return doc.host.paper;
}

export function addPage(doc: BoardDoc, apply: ApplyController): Applied {
    const paper = notebook(doc);
    if (paper.pageCount >= 500) throw new StructureRefused('Maximum pages reached');
    return commit(apply, 'Add page', [{ t: 'board', key: 'host.paper', value: { ...paper, pageCount: paper.pageCount + 1 } }]);
}

export function lastPageContents(doc: BoardDoc): readonly Node[] {
    const paper = notebook(doc);
    if (paper.pageCount <= 1) throw new StructureRefused('A notebook must keep one page');
    return deletionContents(doc, [...(doc.byPage.get(paper.pageCount - 1) ?? [])]);
}

export function deleteLastPage(doc: BoardDoc, apply: ApplyController, resolve?: ResolveConnectorEnd): Applied {
    const paper = notebook(doc);
    const contents = lastPageContents(doc);
    return commit(apply, 'Delete page', [...deletionOps(doc, contents, resolve),
        { t: 'board', key: 'host.paper', value: { ...paper, pageCount: paper.pageCount - 1 } }]);
}

/** Reorders physical pages while preserving each root's unscaled page-local position. */
export function reorderPage(doc: BoardDoc, apply: ApplyController, from: number, to: number): Applied | undefined {
    const { pageCount } = notebook(doc);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= pageCount || to >= pageCount)
        throw new StructureRefused('Invalid page or destination');
    if (from === to) return undefined;
    const ops: Op[] = [];
    for (let page = Math.min(from, to); page <= Math.max(from, to); page++) {
        const next = page === from ? to : page + (from < to ? -1 : 1);
        for (const id of doc.byPage.get(page) ?? []) {
            const node = doc.nodes.get(id);
            if (!node || node.locked) throw new StructureRefused('Locked or unsupported content prevents reordering');
            ops.push({ t: 'set', id, key: 'page', value: next });
        }
    }
    // Empty pages are indistinguishable and have no persisted identity.
    return ops.length ? commit(apply, 'Reorder pages', ops) : undefined;
}
