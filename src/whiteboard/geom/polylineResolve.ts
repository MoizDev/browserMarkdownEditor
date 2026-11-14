import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { AttachmentSurface } from './connectorTypes';
import type { PathOp } from './path';
import { polylineMatrix, type AttachedPolyline } from './polylinePoints';

// Surface and dependency helpers for attached polylines. The end-point arithmetic
// lives once, in geom/polylinePoints.ts (polylinePointSteps / drainPolylinePoints);
// this module only names what a resolution depends on and how to drive its steps.

export function attachedPolylineTargets(node: Readonly<Node>): readonly NodeId[] {
    if (node.kind !== 'polyline') return [];
    const line = node as AttachedPolyline;
    return [...new Set([line.startAttach, line.endAttach].flatMap(entry => entry ? [entry.target] : []))];
}
export function isAttachedPolyline(node: Readonly<Node>): boolean {
    return attachedPolylineTargets(node).length > 0;
}
function frameOutline(w: number, h: number): readonly PathOp[] {
    return [{ op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' }];
}
/** Frame clips around a target, outermost first, in the staged document's world. */
export function polylineSurfaceClips(doc: BoardDoc, node: Readonly<Node>): AttachmentSurface['clips'] {
    const result: AttachmentSurface['clips'][number][] = [];
    let parent = doc.nodes.get(node.parent as NodeId);
    for (let depth = 0; parent && depth < 64; depth++) {
        if (parent.kind === 'frame') result.push({ outline: frameOutline(parent.w, parent.h), localToWorld: polylineMatrix(doc, parent.id) });
        parent = doc.nodes.get(parent.parent as NodeId);
    }
    return result.reverse();
}
/** The renderer's actual attachment surface for one target, in the staged document's world. */
export function polylineSurface(doc: BoardDoc, target: Readonly<Node>, attachments: Pick<AttachmentSurface, 'outline' | 'logicalBox'>, revision: number,
    clips: AttachmentSurface['clips']): AttachmentSurface {
    return { target: target.id, outline: attachments.outline, logicalBox: attachments.logicalBox,
        localToWorld: polylineMatrix(doc, target.id), clips, revision };
}
/** Drives the shared steps to completion. `cooperate` runs between bounded batches of crossing pieces. */
export async function settlePolylineSteps<T>(steps: Generator<void, T, void>, signal: AbortSignal,
    cooperate: () => Promise<void> = () => new Promise<void>(resolve => setTimeout(resolve, 0))): Promise<T> {
    let count = 0, started = performance.now();
    signal.throwIfAborted();
    for (;;) {
        const next = steps.next();
        if (next.done) { signal.throwIfAborted(); return next.value; }
        if (++count >= 256 || performance.now() - started >= 3) {
            signal.throwIfAborted();
            await cooperate();
            signal.throwIfAborted(); count = 0; started = performance.now();
        }
    }
}
