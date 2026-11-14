import { pageAt } from '../../platform/render/pageStack';
import { isLocked, selectedRoots } from '../change/commands';
import { worldPose } from '../change/coordinates';
import type { NodeSetOp, Op } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import { notebookGrowthOp } from '../commands/pagesAndSheets';
import { createBoardTranslationPlan, type BoardTranslationOptions } from '../geom/runtimeTranslation';
import type { BoardSnapGuide } from '../geom/runtimeSnap';
import type { Vec2 } from '../geom/path';
import { hasOpaqueDescendant, isSheetParent, sheetOf } from '../model/doc';
import { NODE_FILE_FIELDS } from '../model/fileFields';
import { newNodeId, type NodeId, type ParentId } from '../model/ids';
import { createNode, type ConnectorNode, type Node } from '../model/nodes';
import { keysBetween } from '../model/orderKey';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { boardPageStack } from '../model/pages';
import { prepareFrameDrop, type FrameDropPlan } from './frameDrop';

export interface DuplicateDragPreview {
    readonly ops: readonly Op[];
    readonly roots: readonly NodeId[];
    readonly guides: readonly BoardSnapGuide[];
}
export interface DuplicateDragPlan {
    preview(point: Vec2, shift: boolean, accel: boolean, signal: AbortSignal, commit?: boolean): Promise<DuplicateDragPreview>;
    commit(value: DuplicateDragPreview): void;
    cancel(): void;
}

/** Clone the complete selected hierarchy into an immutable preview. The source
 * geometry plan supplies every translated pose; originals are never mutated. */
export async function createDuplicateDragPlan(options: BoardTranslationOptions): Promise<DuplicateDragPlan> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const font = runtime.render.text.fonts.epoch;
    let closed = false, serial = 0, work = 0, started = performance.now();
    const current = () => !closed && !signal.aborted && options.current() && runtime.session === session && session.owner === owner
        && session.doc === doc && doc.rev === revision && !session.isReadOnly && runtime.selection.getSnapshot() === selection
        && runtime.render.text.fonts.epoch === font;
    const check = (request?: AbortSignal) => {
        signal.throwIfAborted(); request?.throwIfAborted();
        if (!current()) throw new DOMException('Duplicate drag became stale', 'AbortError');
    };
    const tick = async (request?: AbortSignal) => {
        if (++work < 128 && performance.now() - started < 3) return;
        check(request); await cooperate(); check(request); work = 0; started = performance.now();
    };
    check();
    const roots = selectedRoots(doc, options.ids);
    if (!roots.length) throw new Error('Nothing selected to duplicate');
    const rootSet = new Set(roots.map(node => node.id)), originals: Readonly<Node>[] = [], stack = [...roots].reverse();
    while (stack.length) {
        check(); const node = stack.pop()!;
        if (node.kind === 'opaque' || (rootSet.has(node.id) && (isLocked(doc, node) || hasOpaqueDescendant(doc, node.id)))
            || sheetOf(doc, node.id) !== selection.sheet) {
            throw new Error(`Node cannot be duplicated: ${node.id}`);
        }
        originals.push(node);
        const children = doc.children.get(node.id) ?? [];
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        await tick();
    }
    const reserved = new Set<NodeId>(), ids = new Map<NodeId, NodeId>();
    const tables = { nodes: { has: (id: NodeId) => doc.nodes.has(id) || reserved.has(id) }, sheets: doc.sheets };
    for (const node of originals) { const id = newNodeId(tables); reserved.add(id); ids.set(node.id, id); await tick(); }
    const grouped = new Map<ParentId, NodeId[]>(), order = new Map<NodeId, string>();
    for (const node of roots) { const values = grouped.get(node.parent) ?? []; values.push(node.id); grouped.set(node.parent, values); }
    for (const [parent, values] of grouped) {
        const tail = doc.children.get(parent)?.at(-1)?.order ?? null, keys = keysBetween(tail, null, values.length);
        for (let i = 0; i < values.length; i++) { order.set(values[i], keys[i]); await tick(); }
    }
    const translation = await createBoardTranslationPlan({ ...options, signal });
    let latest: { readonly value: DuplicateDragPreview; readonly scope: BoardGeometryScope | null; readonly drop: FrameDropPlan | null;
        readonly request: AbortSignal; readonly serial: number } | undefined;
    const clear = () => { try { latest?.scope?.release(); } finally { latest?.drop?.release(); latest = undefined; } };
    const close = () => { if (closed) return; closed = true; serial++; clear(); translation.cancel(); };
    const clonedRoots = Object.freeze(roots.map(node => ids.get(node.id)!));
    const rawFor = (node: Readonly<Node>, changes: readonly NodeSetOp[]) => {
        if (!node.ext) return node.ext;
        const raw = new Map(node.ext.raw);
        for (const key of ['id', 'parent', 'order', 'page', 'x', 'y', 'rot', 'start', 'end', 'startAttach', 'endAttach']) raw.delete(key);
        for (const op of changes) if (op.id === node.id) for (const key of NODE_FILE_FIELDS[op.key]) raw.delete(key);
        return { ...node.ext, raw };
    };
    const attachment = (value: ConnectorNode['start']['attach']) => value
        ? { ...value, target: ids.get(value.target) ?? value.target } : null;
    return {
        async preview(point, shift, accel, request, commit = false) {
            check(request); const turn = ++serial;
            const base = await translation.preview(point, shift, accel, request); check(request);
            if (turn !== serial) throw new DOMException('Duplicate drag superseded', 'AbortError');
            if (!base.ops.length) {
                clear(); const value = Object.freeze({ ops: Object.freeze([]), roots: clonedRoots, guides: base.guides });
                latest = { value, scope: null, drop: null, request, serial: turn }; return value;
            }
            let drop: FrameDropPlan | null = null, scope: BoardGeometryScope | undefined;
            try {
            if (commit) drop = await prepareFrameDrop({ runtime, ids: options.ids, preview: base, signal: request, current, cooperate });
            check(request); if (turn !== serial) throw new DOMException('Duplicate drag superseded', 'AbortError');
            const changes = new Map<NodeId, NodeSetOp[]>(), placements = new Map<NodeId, NodeSetOp[]>();
            for (const op of base.ops) { const list = changes.get(op.id) ?? []; list.push(op); changes.set(op.id, list); await tick(request); }
            for (const op of drop?.ops ?? []) {
                if (!rootSet.has(op.id) || !['parent', 'page', 'x', 'y', 'rotation'].includes(op.key)) continue;
                const list = placements.get(op.id) ?? []; list.push(op); placements.set(op.id, list); await tick(request);
            }
            const additions: Node[] = [];
            for (const original of originals) {
                check(request); const moved = base.doc.nodes.get(original.id);
                if (!moved || moved.kind === 'opaque') throw new Error('Duplicate geometry is unavailable');
                const root = rootSet.has(original.id), parent = root ? original.parent : ids.get(original.parent as NodeId);
                if (!parent) throw new Error('Duplicate hierarchy is incomplete');
                let node = createNode({ ...moved, id: ids.get(original.id)!, parent, order: root ? order.get(original.id)! : original.order,
                    ext: rawFor(original, changes.get(original.id) ?? []) });
                for (const patch of placements.get(original.id) ?? []) node = { ...node, [patch.key]: patch.value } as Node;
                if (node.kind === 'connector') node = { ...node,
                    start: { ...node.start, attach: attachment(node.start.attach) }, end: { ...node.end, attach: attachment(node.end.attach) } };
                else if (node.kind === 'polyline') node = { ...node,
                    ...(node.startAttach === undefined ? {} : { startAttach: attachment(node.startAttach) }),
                    ...(node.endAttach === undefined ? {} : { endAttach: attachment(node.endAttach) }) };
                additions.push(node); await tick(request);
            }
            if (drop) {
                const rootIds = new Set(clonedRoots), byParent = new Map<ParentId, number[]>();
                for (let i = 0; i < additions.length; i++) if (rootIds.has(additions[i].id)) {
                    const parent = additions[i].parent, indices = byParent.get(parent) ?? []; indices.push(i); byParent.set(parent, indices);
                }
                for (const [parent, indices] of byParent) {
                    const keys = keysBetween(doc.children.get(parent)?.at(-1)?.order ?? null, null, indices.length);
                    for (let i = 0; i < indices.length; i++) { const index = indices[i]; additions[index] = { ...additions[index], order: keys[i] }; await tick(request); }
                }
            }
            const candidate = createAddedBoardDoc(doc, additions);
                scope = await acquireBoardGeometryScope(runtime, clonedRoots, { doc: candidate, signal: request, current, cooperate });
                check(request); if (turn !== serial) throw new DOMException('Duplicate drag superseded', 'AbortError');
                let deepest = -Infinity;
                for (const id of clonedRoots) { const b = scope.logicalBounds(id); deepest = Math.max(deepest, b.y + b.height); await tick(request); }
                const growth = doc.host.kind === 'notebook' ? notebookGrowthOp(doc, deepest) : undefined;
                const grownHost = growth?.key === 'host.paper' && doc.host.kind === 'notebook' ? { ...doc.host, paper: growth.value } : doc.host;
                const pages = boardPageStack(grownHost), bounds = new Map<NodeId, ReturnType<BoardGeometryScope['logicalBounds']>>();
                if (pages) for (const id of clonedRoots) { bounds.set(id, scope.logicalBounds(id)); await tick(request); }
                const rootIds = new Set(clonedRoots), final: Node[] = [];
                for (const node of additions) {
                    if (pages && rootIds.has(node.id) && isSheetParent(doc, node.parent)) {
                        const box = bounds.get(node.id)!, pose = worldPose(candidate, node.id);
                        const page = pageAt(pages, box.y + box.height / 2), rect = pages.rects[page];
                        if (!rect) throw new Error('Duplicate page is unavailable');
                        final.push({ ...node, x: pose.x - rect.x, y: pose.y - rect.y, page });
                    } else final.push(node);
                    await tick(request);
                }
                const ops: Op[] = [...(growth ? [growth] : []), ...final.map(node => ({ t: 'create' as const, node }))];
                check(request); if (turn !== serial) throw new DOMException('Duplicate drag superseded', 'AbortError');
                const value = Object.freeze({ ops: Object.freeze(ops), roots: clonedRoots, guides: base.guides });
                clear(); latest = { value, scope, drop, request, serial: turn }; scope = undefined; drop = null; return value;
            } finally { try { scope?.release(); } finally { drop?.release(); } }
        },
        commit(value) {
            try {
                check(); if (!latest || latest.value !== value || latest.serial !== serial) throw new DOMException('Duplicate preview is not current', 'AbortError');
                latest.request.throwIfAborted();
                if (value.ops.length) {
                    const applied = session.apply({ origin: 'tool', label: 'Duplicate and move', ops: value.ops });
                    try { runtime.selection.replace(value.roots); } finally { applied.release(); }
                }
            } finally { close(); }
        },
        cancel: close,
    };
}
