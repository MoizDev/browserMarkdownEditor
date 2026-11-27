import { childrenOf, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import { yieldToHost } from '../../platform/yieldToHost';

export async function prepareContainerContents(doc: BoardDoc, containers: readonly Node[], options: {
    readonly signal: AbortSignal; readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<ReadonlyMap<NodeId, readonly Node[]>> {
    const revision = doc.rev, host = doc.host, cooperate = options.cooperate ?? yieldToHost;
    let work = 0, started = performance.now();
    const check = () => { options.signal.throwIfAborted(); if (!options.current() || doc.rev !== revision || doc.host !== host) throw new DOMException('Container contents became stale', 'AbortError'); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const result = new Map<NodeId, readonly Node[]>(), visited = new Set<NodeId>();
    for (const container of containers) {
        check();
        if (doc.nodes.get(container.id) !== container || (container.kind !== 'group' && container.kind !== 'frame'))
            throw new Error('Container changed before its contents were prepared');
        const direct: Node[] = [], pending: Node[] = [];
        for (const child of childrenOf(doc, container.id)) {
            direct.push(child); pending.push(child); if (due()) await tick();
        }
        result.set(container.id, Object.freeze(direct));
        while (pending.length) {
            const node = pending.pop()!;
            if (visited.has(node.id)) throw new Error('Container descendant graph is cyclic or shared');
            visited.add(node.id);
            if (node.kind === 'opaque' || node.locked) throw new Error('Locked or opaque descendants prevent container removal');
            for (const child of childrenOf(doc, node.id)) { pending.push(child); if (due()) await tick(); }
            if (due()) await tick();
        }
    }
    check(); return result;
}
