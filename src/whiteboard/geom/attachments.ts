import type { Op } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { DetachContext, IncidentEnd } from './connectorTypes';

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

/** Resolve every last painted tip before returning any operations for the caller's transaction. */
export function detachIncidentEnds(doc: Readonly<BoardDoc>, target: NodeId, context: DetachContext): readonly Op[] {
    const ops: Op[] = [];
    for (const incident of incidentEnds(doc, target)) {
        const world = context.resolvedTip(incident.connector, incident.terminal);
        const local = world && context.toConnectorLocal(incident.connector, world);
        if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.y)) throw new Error('Connector tip is not ready to detach');
        const value = { x: local.x, y: local.y, attach: null };
        if (incident.terminal === 'start') ops.push({ t: 'set', id: incident.connector, key: 'start', value });
        else ops.push({ t: 'set', id: incident.connector, key: 'end', value });
    }
    return ops;
}
