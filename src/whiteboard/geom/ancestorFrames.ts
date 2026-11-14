import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';

/** Frame ancestors, nearest first. An incomplete or cyclic chain is never an
 * empty clip stack: callers must not expose geometry outside an unknown frame. */
export function boardFrameAncestors(doc: BoardDoc, node: Readonly<Node>): readonly Readonly<Extract<Node, { kind: 'frame' }>>[] {
    const frames: Readonly<Extract<Node, { kind: 'frame' }>>[] = [], seen = new Set<NodeId>();
    let parent = node.parent;
    for (let depth = 0; depth <= 64; depth++) {
        if (isSheetParent(doc, parent)) return frames;
        const id = parent as NodeId;
        if (seen.has(id)) throw new RangeError('Frame ancestor cycle');
        seen.add(id);
        const ancestor = doc.nodes.get(id); if (!ancestor) throw new Error('Frame ancestor disappeared');
        if (ancestor.kind === 'frame') frames.push(ancestor);
        parent = ancestor.parent;
    }
    throw new RangeError('Frame ancestor depth limit exhausted');
}
