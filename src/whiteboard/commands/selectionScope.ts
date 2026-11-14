import { isLocked } from '../change/commands';
import { childrenOf, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { selectedRootsAsync } from '../geom/selectedRootsAsync';

/** Validate one immutable selection snapshot without rescanning overlapping
 * subtrees or sorting a large selection synchronously on the input thread. */
export async function prepareSelectionScope(options: {
    readonly doc: BoardDoc; readonly ids: readonly NodeId[]; readonly sheet: SheetId; readonly focus: ParentId;
    readonly structural: boolean; readonly preserveNested?: boolean; readonly signal: AbortSignal;
    readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<Node[]> {
    const { doc, signal } = options, revision = doc.rev, host = doc.host;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let work = 0, started = performance.now();
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || doc.rev !== revision || doc.host !== host) throw new DOMException('Selection scope became stale', 'AbortError');
    };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    check(); let nodes: Node[];
    if (options.preserveNested) {
        nodes = []; const seen = new Set<NodeId>();
        for (const id of options.ids) {
            if (!seen.has(id)) {
                seen.add(id); const node = doc.nodes.get(id); if (!node) throw new Error('Selected node disappeared'); nodes.push(node);
            }
            if (due()) await tick();
        }
    } else nodes = await selectedRootsAsync(doc, options.ids, { signal, current: options.current, cooperate });
    check();
    for (const node of nodes) {
        if (sheetOf(doc, node.id) !== options.sheet) throw new Error('Selection spans another sheet');
        let parent: ParentId = node.parent, inFocus = node.id === options.focus || parent === options.focus;
        for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
            const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Selection parent is missing');
            parent = ancestor.parent; inFocus = parent === options.focus;
        }
        if (!inFocus) throw new Error('Selection is outside the current focus');
        if (options.structural && isLocked(doc, node)) throw new Error('Locked content cannot be restructured');
        if (due()) await tick();
    }
    if (options.structural) {
        const pending: Node[] = [], visited = new Set<NodeId>();
        for (const node of nodes) { pending.push(node); if (due()) await tick(); }
        while (pending.length) {
            const node = pending.pop()!;
            if (visited.has(node.id)) throw new Error('Selection hierarchy is cyclic or duplicated');
            visited.add(node.id);
            if (node.kind === 'opaque') throw new Error('Opaque content cannot be restructured');
            for (const child of childrenOf(doc, node.id)) { pending.push(child); if (due()) await tick(); }
            if (due()) await tick();
        }
    }
    check(); return nodes;
}

/** Resolve opaque-descendant flags once per shared subtree, cooperatively. */
export async function inspectOpaqueSubtrees(doc: BoardDoc, roots: readonly NodeId[], options: {
    readonly signal: AbortSignal; readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<ReadonlyMap<NodeId, boolean>> {
    const revision = doc.rev, host = doc.host, cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let work = 0, started = performance.now();
    const check = () => { options.signal.throwIfAborted(); if (!options.current() || doc.rev !== revision || doc.host !== host) throw new DOMException('Opaque subtree scan became stale', 'AbortError'); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const memo = new Map<NodeId, boolean>(), active = new Set<NodeId>();
    type Frame = { readonly node: Node; readonly children: readonly Node[]; index: number; opaque: boolean };
    for (const id of roots) {
        check(); if (memo.has(id)) continue;
        const root = doc.nodes.get(id); if (!root) throw new Error('Opaque subtree root disappeared');
        const stack: Frame[] = [{ node: root, children: childrenOf(doc, id), index: 0, opaque: root.kind === 'opaque' }]; active.add(id);
        while (stack.length) {
            const frame = stack[stack.length - 1];
            if (frame.index < frame.children.length) {
                const child = frame.children[frame.index++], known = memo.get(child.id);
                if (known !== undefined) frame.opaque ||= known;
                else {
                    if (active.has(child.id)) throw new Error('Opaque subtree hierarchy contains a cycle');
                    active.add(child.id); stack.push({ node: child, children: childrenOf(doc, child.id), index: 0, opaque: child.kind === 'opaque' });
                }
            } else {
                stack.pop(); active.delete(frame.node.id); memo.set(frame.node.id, frame.opaque);
                if (stack.length) stack[stack.length - 1].opaque ||= frame.opaque;
            }
            if (due()) await tick();
        }
    }
    check(); return memo;
}
