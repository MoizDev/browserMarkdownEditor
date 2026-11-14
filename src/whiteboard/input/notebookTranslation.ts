import { pageAt } from '../../platform/render/pageStack';
import { selectedRoots } from '../change/commands';
import type { NodeSetOp, Op } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import type { BoardTranslationPreview } from '../geom/runtimeTranslation';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import { boardPageStack } from '../model/pages';

interface TransformPreview { readonly doc: BoardDoc; readonly ops: readonly Op[] }
export interface NotebookTransformOptions<T extends TransformPreview> {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly preview: T;
    readonly signal: AbortSignal;
    current(): boolean;
    cooperate?(): Promise<void>;
}
export interface NotebookTransform<T extends TransformPreview> {
    readonly preview: T;
    readonly ops: readonly Op[];
    release(): void;
}

/** Page growth and actual-geometry page ownership are staged with the move.
 * Existing page-local coordinates are converted through their world poses only
 * after the grown stack has been established, never by moving the content. */
export async function prepareNotebookTransform<T extends TransformPreview>(options: NotebookTransformOptions<T>): Promise<NotebookTransform<T> | null> {
    const { runtime, preview, signal } = options, session = runtime.session, doc = session.doc;
    if (doc.host.kind !== 'notebook' || !preview.ops.length) return null;
    const owner = session.owner, revision = doc.rev, selection = runtime.selection.getSnapshot(), font = runtime.render.text.fonts.epoch;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const current = () => !signal.aborted && options.current() && runtime.session === session && session.owner === owner
        && session.doc === doc && doc.rev === revision && runtime.selection.getSnapshot() === selection && runtime.render.text.fonts.epoch === font;
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Notebook translation became stale', 'AbortError'); };
    check(); const roots = selectedRoots(doc, options.ids);
    if (!roots.length) return null;
    const first = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { doc: preview.doc, signal, current, cooperate });
    let result: BoardGeometryScope | undefined, retained = false;
    try {
        let deepest = -Infinity, work = 0, started = performance.now();
        for (const root of roots) {
            check(); const bounds = first.logicalBounds(root.id); deepest = Math.max(deepest, bounds.y + bounds.height);
            if (++work >= 128 || performance.now() - started >= 3) { await cooperate(); check(); work = 0; started = performance.now(); }
        }
        const growth = notebookGrowthOp(doc, deepest);
        if (!growth || growth.key !== 'host.paper') return null;
        const grownHost = { ...doc.host, paper: growth.value }, grownStack = boardPageStack(grownHost);
        if (!grownStack?.rects.length) throw new Error('Grown notebook has no pages');
        const corrections: NodeSetOp[] = [];
        for (const root of roots) {
            check(); const node = preview.doc.nodes.get(root.id);
            if (!node || node.kind === 'opaque') throw new Error('Notebook move root is unavailable');
            if (!isSheetParent(preview.doc, node.parent)) continue;
            const bounds = first.logicalBounds(node.id), world = first.worldPose(node.id);
            const page = pageAt(grownStack, bounds.y + bounds.height / 2), rect = grownStack.rects[page];
            if (!rect) throw new Error('Notebook destination page is unavailable');
            const x = world.x - rect.x, y = world.y - rect.y;
            if (![x, y].every(Number.isFinite)) throw new RangeError('Notebook destination overflows');
            if (node.page !== page) corrections.push({ t: 'set', id: node.id, key: 'page', value: page });
            if (node.x !== x) corrections.push({ t: 'set', id: node.id, key: 'x', value: x });
            if (node.y !== y) corrections.push({ t: 'set', id: node.id, key: 'y', value: y });
            if (++work >= 128 || performance.now() - started >= 3) { await cooperate(); check(); work = 0; started = performance.now(); }
        }
        const grown = { ...preview.doc, host: grownHost };
        const final = corrections.length ? await projectBoardGeometrySets(grown, corrections, { signal, current, cooperate }) : grown;
        check(); result = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { doc: final, signal, current, cooperate });
        check();
        const projected = Object.freeze({ ...preview, doc: final, ops: Object.freeze([...preview.ops, ...corrections]) }) as T;
        const ops: readonly Op[] = Object.freeze([growth, ...projected.ops]);
        const lease = result; retained = true;
        return { preview: projected, ops, release: () => lease.release() };
    } finally { try { first.release(); } finally { if (!retained) result?.release(); } }
}

export type NotebookTranslation = NotebookTransform<BoardTranslationPreview>;
export function prepareNotebookTranslation(options: NotebookTransformOptions<BoardTranslationPreview>): Promise<NotebookTranslation | null> {
    return prepareNotebookTransform(options);
}
