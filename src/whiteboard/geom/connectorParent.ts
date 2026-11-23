import { isSheetParent } from '../model/doc';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Attachment } from '../model/nodes';

/** The container an arrow with both ends bound belongs to: the nearest ancestor its two bound shapes share (a frame, a group, or the
 * sheet). Catalogue a.5 (ArrowBindingUtil: the closest common frame-like ancestor, else the common ancestor, else the page). A free
 * end binds nothing, so the arrow keeps the container it has. */
export function bindingContainer(doc: Readonly<BoardDoc>, start: Readonly<Attachment> | null | undefined,
    end: Readonly<Attachment> | null | undefined): ParentId | null {
    if (!start || !end) return null;
    const chain = (target: NodeId): ParentId[] => {
        const out: ParentId[] = [];
        let parent = doc.nodes.get(target)?.parent;
        for (let depth = 0; parent !== undefined && depth <= 64; depth++) {
            out.push(parent);
            if (isSheetParent(doc, parent)) break;
            parent = doc.nodes.get(parent as NodeId)?.parent;
        }
        return out;
    };
    const ends = new Set<ParentId>(chain(end.target));
    return chain(start.target).find(parent => ends.has(parent)) ?? null;
}
