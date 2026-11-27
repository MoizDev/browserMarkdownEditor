import type { ApplyController } from '../change/apply';
import type { Applied, Op } from '../change/ops';
import { isLocked, moveNodesToSheet, selectedRoots } from '../change/commands';
import type { BoardRuntime } from '../host/runtime';
import { hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { boardPageStack } from '../model/pages';
import { newSheetId } from '../model/ids';
import { addSheet } from './pagesAndSheets';

type MutationPort = Pick<ApplyController, 'apply'>;

export type PageMoveBlock = 'no-pages' | 'no-selection' | 'nested' | 'opaque' | 'locked' | 'current-page' | 'read-only' | 'busy';
export interface PageMoveTarget {
    readonly id: string;
    readonly page: number;
    readonly label: string;
    readonly enabled: boolean;
    readonly reason?: PageMoveBlock;
}

const PAGE_ID = /^page:(0|[1-9]\d*)$/;
export function pageMoveId(page: number): string { return `page:${page}`; }
export function parsePageMoveId(id: string): number {
    const match = PAGE_ID.exec(id);
    if (!match) throw new RangeError(`Invalid page target: ${id}`);
    return Number(match[1]);
}

export function pageCount(doc: BoardDoc): number { return boardPageStack(doc.host)?.rects.length ?? 0; }

export function movableSelectionRoots(doc: BoardDoc, ids: Iterable<NodeId>): { readonly roots: readonly Node[]; readonly block?: PageMoveBlock } {
    if (doc.kind === 'whiteboard') return { roots: [], block: 'no-pages' };
    return movableRoots(doc, ids);
}

function movableRoots(doc: BoardDoc, ids: Iterable<NodeId>): { readonly roots: readonly Node[]; readonly block?: PageMoveBlock } {
    let roots: Node[];
    try { roots = selectedRoots(doc, ids); } catch {
        return { roots: [], block: 'no-selection' };
    }
    if (!roots.length) return { roots, block: 'no-selection' };
    for (const node of roots) {
        if (!isSheetParent(doc, node.parent)) return { roots, block: 'nested' };
        if (node.kind === 'opaque' || hasOpaqueDescendant(doc, node.id)) return { roots, block: 'opaque' };
        if (isLocked(doc, node)) return { roots, block: 'locked' };
    }
    return { roots };
}

export function pageMoveTargets(doc: BoardDoc, ids: Iterable<NodeId>): readonly PageMoveTarget[] {
    const count = pageCount(doc);
    if (!count) return [];
    const { roots, block } = movableSelectionRoots(doc, ids);
    return Array.from({ length: count }, (_, page) => {
        const reason = block ?? (roots.every(node => node.page === page) ? 'current-page' : undefined);
        return { id: pageMoveId(page), page, label: String(page + 1), enabled: reason === undefined, reason };
    });
}

export function moveSelectionToPage(doc: BoardDoc, apply: MutationPort, ids: Iterable<NodeId>, page: number): Applied | undefined {
    const count = pageCount(doc);
    if (!Number.isInteger(page) || page < 0 || page >= count) throw new RangeError('Page target is outside the board');
    const { roots, block } = movableSelectionRoots(doc, ids);
    if (block) throw new Error(`Selection cannot move to a page: ${block}`);
    const ops: Op[] = [];
    for (const node of roots) if (node.page !== page) ops.push({ t: 'set', id: node.id, key: 'page', value: page });
    if (!ops.length) return undefined;
    return apply.apply({ origin: 'host', label: 'Move to page', ops });
}

const SHEET_ID = /^sheet:(.+)$/;
export function sheetMoveId(sheet: SheetId): string { return `sheet:${sheet}`; }
function parseSheetMoveId(id: string): SheetId | undefined {
    const match = SHEET_ID.exec(id);
    return match ? match[1] as SheetId : undefined;
}

export function sheetMoveTargets(doc: BoardDoc, ids: Iterable<NodeId>): readonly PageMoveTarget[] {
    const { roots, block } = movableRoots(doc, ids);
    return doc.sheetOrder.map(({ id, name }) => {
        const reason = block ?? (roots.every(node => sheetOf(doc, node.id) === id) ? 'current-page' : undefined);
        return { id: sheetMoveId(id), page: -1, label: name, enabled: reason === undefined, reason };
    });
}

function moveSelectionToSheet(runtime: BoardRuntime, ids: readonly NodeId[], target: SheetId): void {
    const session = runtime.session, doc = session.doc, { block } = movableRoots(doc, ids);
    if (block) throw new Error(`Selection cannot move to a sheet: ${block}`);
    session.history.open('Move to sheet');
    let builder: ReturnType<typeof session.begin> | undefined, open = true;
    try {
        builder = session.begin('host', 'Move to sheet');
        const moved = moveNodesToSheet(doc, builder, ids, target, runtime.render.changeGeometry);
        if (!moved.length) { builder.abort(); builder = undefined; session.history.cancel(); open = false; return; }
        const applied = builder.commit(); builder = undefined;
        try { runtime.selection.setSheet(target); runtime.selection.replace(moved); } finally { applied.release(); }
        session.history.close(); open = false;
    } catch (error) {
        try { builder?.abort(); } finally { if (open) session.history.cancel(); }
        throw error;
    }
}

function moveSelectionToNewSheet(runtime: BoardRuntime, ids: readonly NodeId[], name: string): void {
    const session = runtime.session, doc = session.doc, { block } = movableRoots(doc, ids);
    if (block) throw new Error(`Selection cannot move to a sheet: ${block}`);
    const id = newSheetId({ nodes: doc.nodes, sheets: doc.sheets });
    session.history.open('Move to new sheet');
    let builder: ReturnType<typeof session.begin> | undefined, open = true;
    try {
        addSheet(doc, session, id, name).release();
        builder = session.begin('host', 'Move to new sheet');
        const moved = moveNodesToSheet(doc, builder, ids, id, runtime.render.changeGeometry);
        const applied = builder.commit(); builder = undefined;
        try { runtime.selection.setSheet(id); runtime.selection.replace(moved); } finally { applied.release(); }
        session.history.close(); open = false;
    } catch (error) {
        try { builder?.abort(); } finally { if (open) session.history.cancel(); }
        throw error;
    }
}

export function createPageMoveBackend(runtime: BoardRuntime) {
    const selected = (): readonly NodeId[] => [...runtime.selection.getSnapshot().selected];
    const blocked = (): PageMoveBlock | undefined => runtime.session.isReadOnly ? 'read-only'
        : runtime.session.isGestureActive ? 'busy' : undefined;
    return {
        targets(): readonly PageMoveTarget[] {
            const doc = runtime.session.doc, stop = blocked();
            const rows = [...sheetMoveTargets(doc, selected()), ...pageMoveTargets(doc, selected())];
            return stop ? rows.map(row => ({ ...row, enabled: false, reason: stop })) : rows;
        },
        newSheetBlock(): string | undefined {
            const stop = blocked();
            if (stop) return stop;
            const doc = runtime.session.doc;
            if (doc.sheetOrder.length >= 40) return 'sheet-limit';
            return movableRoots(doc, selected()).block;
        },
        moveToNewSheet(name: string): void {
            const stop = blocked();
            if (stop) throw new Error(`Selection cannot move to a sheet: ${stop}`);
            moveSelectionToNewSheet(runtime, selected(), name);
        },
        moveToPage(id: string): void {
            const stop = blocked();
            if (stop) throw new Error(`Selection cannot move to a page: ${stop}`);
            const sheet = parseSheetMoveId(id);
            if (sheet !== undefined) { moveSelectionToSheet(runtime, selected(), sheet); return; }
            moveSelectionToPage(runtime.session.doc, runtime.session, selected(), parsePageMoveId(id))?.release();
        },
    };
}
