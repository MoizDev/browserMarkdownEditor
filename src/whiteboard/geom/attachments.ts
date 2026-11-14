import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { NodeSetOp } from '../change/ops';
import type { Attachment, PolylineNode } from '../model/nodes';
import type { IncidentEnd } from './connectorTypes';

/** The model's target index is authoritative; a self-targeted pair has two distinct ends. */
/** Default, calibration cut by owner: a reflected target mirrors normalized attached anchors. */
export function reflectedTargetAnchors(doc: Readonly<BoardDoc>, target: NodeId, flipX: boolean, flipY: boolean): readonly NodeSetOp[] {
    if (!flipX && !flipY) return [];
    const ops: NodeSetOp[] = [];
    const reflect = (attachment: Attachment): Attachment => ({ ...attachment, anchor: {
        x: flipX ? 1 - attachment.anchor.x : attachment.anchor.x,
        y: flipY ? 1 - attachment.anchor.y : attachment.anchor.y,
    } });
    for (const id of doc.attachedTo.get(target) ?? []) {
        const node = doc.nodes.get(id); if (!node) throw new Error('Attached node disappeared');
        if (node.kind === 'connector') {
            for (const side of ['start', 'end'] as const) {
                const end = node[side]; if (end.attach?.target !== target) continue;
                ops.push({ t: 'set', id, key: side, value: { ...end, attach: reflect(end.attach) } });
            }
        } else if (node.kind === 'polyline') {
            const line = node as Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
            for (const key of ['startAttach', 'endAttach'] as const) {
                const value = line[key]; if (value?.target === target) ops.push({ t: 'set', id, key, value: reflect(value) } as unknown as NodeSetOp);
            }
        } else throw new Error('Invalid attachment index entry');
    }
    return ops;
}

export function incidentEnds(doc: Readonly<BoardDoc>, target: NodeId): readonly IncidentEnd[] {
    const ends: IncidentEnd[] = [];
    for (const id of doc.attachedTo.get(target) ?? []) {
        const node = doc.nodes.get(id);
        if (!node) throw new Error('Invalid connector attachment index');
        if (node.kind === 'polyline') {
            const line = node as Readonly<PolylineNode> & { readonly startAttach?: Attachment | null; readonly endAttach?: Attachment | null };
            if (line.startAttach?.target !== target && line.endAttach?.target !== target) throw new Error('Stale polyline attachment index');
            continue;
        }
        if (node.kind !== 'connector') throw new Error('Invalid connector attachment index');
        if (node.start.attach?.target === target) ends.push({ connector: id, terminal: 'start' });
        if (node.end.attach?.target === target) ends.push({ connector: id, terminal: 'end' });
        if (node.start.attach?.target !== target && node.end.attach?.target !== target) throw new Error('Stale connector attachment index');
    }
    return ends;
}

