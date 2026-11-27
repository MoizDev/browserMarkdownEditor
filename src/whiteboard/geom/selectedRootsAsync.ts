import { refuseChange } from '../change/errors';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import { compareOrder } from '../model/orderKey';
import { yieldToHost } from '../../platform/yieldToHost';

interface RootPath { readonly node: Node; readonly sheet: BoardDoc['sheetOrder'][number]; readonly path: readonly Node[] }

export async function selectedRootsAsync(doc: BoardDoc, ids: Iterable<NodeId>, options: {
    readonly signal: AbortSignal;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}): Promise<Node[]> {
    const revision = doc.rev, host = doc.host, cooperate = options.cooperate ?? yieldToHost;
    let work = 0, started = performance.now();
    const check = () => { options.signal.throwIfAborted(); if (!options.current() || doc.rev !== revision || doc.host !== host) throw new DOMException('Selection roots changed', 'AbortError'); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    check(); const selected = new Set<NodeId>();
    for (const id of ids) { selected.add(id); if (due()) await tick(); }
    const roots: RootPath[] = [];
    for (const id of selected) {
        check(); const node = doc.nodes.get(id); if (!node) refuseChange('V-1', 'Node does not exist', id);
        const path: Node[] = [node]; let current = node, covered = false, sheet: RootPath['sheet'] | undefined;
        for (let depth = 0; depth <= 64; depth++) {
            if (isSheetParent(doc, current.parent)) { sheet = doc.sheets.get(current.parent as SheetId); break; }
            if (selected.has(current.parent as NodeId)) covered = true;
            const parent = doc.nodes.get(current.parent as NodeId); if (!parent) refuseChange('V-2', 'Parent does not exist', id);
            path.push(parent); current = parent;
        }
        if (!sheet) throw new Error('Selection hierarchy exceeds its depth limit');
        if (!covered) roots.push({ node, sheet, path: path.reverse() });
        if (due()) await tick();
    }
    const compare = (a: RootPath, b: RootPath): number => {
        if (a.node.id === b.node.id) return 0;
        if (a.sheet.id !== b.sheet.id) return compareOrder(a.sheet, b.sheet);
        const count = Math.min(a.path.length, b.path.length); let index = 0;
        while (index < count && a.path[index].id === b.path[index].id) index++;
        return index === count ? a.path.length - b.path.length : compareOrder(a.path[index], b.path[index]);
    };
    let sorted = roots, buffer = new Array<RootPath>(roots.length);
    for (let width = 1; width < sorted.length; width *= 2) {
        for (let start = 0; start < sorted.length; start += width * 2) {
            const middle = Math.min(start + width, sorted.length), end = Math.min(start + width * 2, sorted.length);
            let left = start, right = middle;
            for (let out = start; out < end; out++) {
                buffer[out] = left < middle && (right >= end || compare(sorted[left], sorted[right]) <= 0) ? sorted[left++] : sorted[right++];
                if (due()) await tick();
            }
        }
        [sorted, buffer] = [buffer, sorted];
    }
    const result: Node[] = [];
    for (const value of sorted) { if (doc.nodes.get(value.node.id) !== value.node) throw new DOMException('Selection root changed', 'AbortError');
        result.push(value.node); if (due()) await tick(); }
    check(); return result;
}
