import { isSheetParent } from '../model/doc';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Attachment } from '../model/nodes';

export function bindingContainer(doc: Readonly<BoardDoc>, start: Readonly<Attachment> | null | undefined,
    end: Readonly<Attachment> | null | undefined, parentOf: (id: NodeId) => ParentId | undefined = id => doc.nodes.get(id)?.parent): ParentId | null {
    if (!start || !end) return null;
    const chain = (target: NodeId): ParentId[] => {
        const out: ParentId[] = [];
        let parent = parentOf(target);
        for (let depth = 0; parent !== undefined && depth <= 64; depth++) {
            out.push(parent);
            if (isSheetParent(doc, parent)) break;
            parent = parentOf(parent as NodeId);
        }
        return out;
    };
    const ends = new Set<ParentId>(chain(end.target));
    return chain(start.target).find(parent => ends.has(parent)) ?? null;
}
