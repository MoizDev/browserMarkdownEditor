import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { IncidentEnd } from './connectorTypes';

/** The model's target index is authoritative; a self-targeted pair has two distinct ends. */
export function incidentEnds(doc: Readonly<BoardDoc>, target: NodeId): readonly IncidentEnd[] {
    const ends: IncidentEnd[] = [];
    for (const id of doc.attachedTo.get(target) ?? []) {
        const node = doc.nodes.get(id);
        if (!node || node.kind !== 'connector') throw new Error('Invalid connector attachment index');
        if (node.start.attach?.target === target) ends.push({ connector: id, terminal: 'start' });
        if (node.end.attach?.target === target) ends.push({ connector: id, terminal: 'end' });
        if (node.start.attach?.target !== target && node.end.attach?.target !== target) throw new Error('Stale connector attachment index');
    }
    return ends;
}

