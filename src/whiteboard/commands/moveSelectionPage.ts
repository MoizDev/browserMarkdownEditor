import type { ApplyController } from '../change/apply';
import type { Applied, Op } from '../change/ops';
import { isLocked, selectedRoots } from '../change/commands';
import type { BoardRuntime } from '../host/runtime';
import { hasOpaqueDescendant, isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import { boardPageStack } from '../model/pages';

// Provenance: page placement by the canonical page field, with page-local
// positions preserved as reorderPage does; independent composition, no third-party source.

type MutationPort = Pick<ApplyController, 'apply'>;

/** Why a page target cannot be used. Core maps these codes to its own copy. */
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

/** Physical pages of a paged host. A whiteboard has none, so it cannot move a selection to a page. */
export function pageCount(doc: BoardDoc): number { return boardPageStack(doc.host)?.rects.length ?? 0; }

/**
 * The movable top-level roots of the selection, or the first reason none can move. Only a
 * top-level root carries a physical page: a node inside a container follows its container,
 * so moving it alone would detach it from that container, which the plan does not define.
 */
export function movableSelectionRoots(doc: BoardDoc, ids: Iterable<NodeId>): { readonly roots: readonly Node[]; readonly block?: PageMoveBlock } {
    if (doc.kind === 'whiteboard') return { roots: [], block: 'no-pages' };
    let roots: Node[];
    try { roots = selectedRoots(doc, ids); } catch {
        // A selection naming a node that no longer exists has nothing movable; the next selection event refreshes it.
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

/** One row per physical page; a row is enabled when the whole selection is movable and not already on it. */
export function pageMoveTargets(doc: BoardDoc, ids: Iterable<NodeId>): readonly PageMoveTarget[] {
    const count = pageCount(doc);
    if (!count) return [];
    const { roots, block } = movableSelectionRoots(doc, ids);
    return Array.from({ length: count }, (_, page) => {
        const reason = block ?? (roots.every(node => node.page === page) ? 'current-page' : undefined);
        return { id: pageMoveId(page), page, label: String(page + 1), enabled: reason === undefined, reason };
    });
}

/**
 * Moves the selection's movable roots to a physical page as one transaction. Only the page field
 * changes; each root keeps its page-local position, and attachments stay bound because the sheet
 * does not change, so a bound polyline or connector end follows its target and nothing is detached.
 */
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

/** The live backend Core's context menu uses: targets come from the current document and selection. */
export function createPageMoveBackend(runtime: BoardRuntime) {
    const selected = (): readonly NodeId[] => [...runtime.selection.getSnapshot().selected];
    const blocked = (): PageMoveBlock | undefined => runtime.session.isReadOnly ? 'read-only'
        : runtime.session.isGestureActive ? 'busy' : undefined;
    return {
        targets(): readonly PageMoveTarget[] {
            const doc = runtime.session.doc, stop = blocked(), rows = pageMoveTargets(doc, selected());
            return stop ? rows.map(row => ({ ...row, enabled: false, reason: stop })) : rows;
        },
        moveToPage(id: string): void {
            const stop = blocked();
            if (stop) throw new Error(`Selection cannot move to a page: ${stop}`);
            moveSelectionToPage(runtime.session.doc, runtime.session, selected(), parsePageMoveId(id))?.release();
        },
    };
}
