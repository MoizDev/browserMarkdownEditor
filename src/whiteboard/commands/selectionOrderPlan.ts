import { childrenOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { SelectionOrder } from './selection';
import { yieldToHost } from '../../platform/yieldToHost';

export interface SelectionOrderRun {
    readonly parent: ParentId;
    readonly before: NodeId | null;
    readonly after: NodeId | null;
    readonly ids: readonly NodeId[];
}

/** Build stable sibling runs before opening the history transaction; the
 * commit only allocates current order keys and applies these prepared runs. */
export async function prepareSelectionOrderPlan(doc: BoardDoc, roots: readonly Node[], direction: SelectionOrder, options: {
    readonly signal: AbortSignal; readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<readonly SelectionOrderRun[]> {
    const revision = doc.rev, host = doc.host, cooperate = options.cooperate ?? yieldToHost;
    let work = 0, started = performance.now();
    const check = () => { options.signal.throwIfAborted(); if (!options.current() || doc.rev !== revision || doc.host !== host) throw new DOMException('Selection order plan became stale', 'AbortError'); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const parents = new Map<ParentId, Set<NodeId>>(), result: SelectionOrderRun[] = [];
    for (const node of roots) {
        const selected = parents.get(node.parent) ?? new Set<NodeId>(); selected.add(node.id); parents.set(node.parent, selected);
        if (due()) await tick();
    }
    for (const [parent, selected] of parents) {
        check(); const original: NodeId[] = [], desired: NodeId[] = [], chosen: NodeId[] = [], other: NodeId[] = [];
        let found = 0;
        for (const node of childrenOf(doc, parent)) {
            original.push(node.id); if (selected.has(node.id)) found++;
            if (direction === 'front' || direction === 'back') (selected.has(node.id) ? chosen : other).push(node.id);
            else desired.push(node.id);
            if (due()) await tick();
        }
        if (found !== selected.size) throw new Error('Selection order siblings are inconsistent');
        if (direction === 'front' || direction === 'back') {
            const order = direction === 'front' ? [other, chosen] : [chosen, other];
            for (const list of order) for (const id of list) { desired.push(id); if (due()) await tick(); }
        } else if (direction === 'forward') {
            for (let i = desired.length - 2; i >= 0; i--) {
                if (selected.has(desired[i]) && !selected.has(desired[i + 1])) [desired[i], desired[i + 1]] = [desired[i + 1], desired[i]];
                if (due()) await tick();
            }
        } else {
            for (let i = 1; i < desired.length; i++) {
                if (selected.has(desired[i]) && !selected.has(desired[i - 1])) [desired[i], desired[i - 1]] = [desired[i - 1], desired[i]];
                if (due()) await tick();
            }
        }
        for (let i = 0; i < desired.length;) {
            if (!selected.has(desired[i])) { i++; if (due()) await tick(); continue; }
            const start = i; let changed = false; const ids: NodeId[] = [];
            while (i < desired.length && selected.has(desired[i])) {
                ids.push(desired[i]); if (desired[i] !== original[i]) changed = true; i++;
                if (due()) await tick();
            }
            if (changed) result.push(Object.freeze({ parent, before: start ? desired[start - 1] : null,
                after: i < desired.length ? desired[i] : null, ids: Object.freeze(ids) }));
        }
    }
    check(); return Object.freeze(result);
}
