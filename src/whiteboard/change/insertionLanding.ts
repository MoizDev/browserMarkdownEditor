import { isLocked } from './commands';
import type { Op } from './ops';
import { isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Attachment, Node } from '../model/nodes';
import { compareOrder, keysBetween } from '../model/orderKey';
import type { SelectionSnapshot } from '../selection';

/** The board changed under a prepared insertion in a way it cannot follow (its frame went, an id or a picture it adds now
 * exists, the notebook's paper changed): the caller prepares the insertion again from what it was given. */
export class InsertionStale extends Error {
    constructor(reason: string) { super(`The board changed before the insertion landed: ${reason}`); this.name = 'InsertionStale'; }
}

/** What the insertion was prepared against, read when its preparation began. */
export interface InsertionBasis {
    readonly doc: BoardDoc;
    readonly host: BoardDoc['host'];
}
export function insertionBasis(doc: BoardDoc): InsertionBasis { return { doc, host: doc.host }; }

/**
 * A paste, a drop or a duplicate is prepared off the gesture path (classified, decoded, its pictures stored, measured) and
 * lands once no gesture holds the board. A press made meanwhile takes its gesture first, and what that gesture commits (a
 * stroke, a move, an erase, an undo) moves the document under the prepared changes. Fenced on the revision, every such paste
 * was thrown away with "Nothing was pasted: the paste was interrupted" (measured: a box, a click, a stroke or a drag begun
 * within 100 ms of ⌘V lost a six-stroke paste every time; a 200-stroke paste took 220 ms to prepare). Re-preparing instead
 * could starve: with a pen writing, a commit lands between almost any two strokes. So the changes are carried over, here,
 * synchronously, inside the task that applies them: what they create lands on top of what is there now, ids and pictures
 * are re-checked, and an arrow bound to something since deleted lets go of it. Only what this cannot follow is refused.
 */
export function rebaseInsertion(doc: BoardDoc, basis: InsertionBasis, ops: readonly Op[]): Op[] {
    if (doc !== basis.doc) throw new InsertionStale('the document was replaced');
    const created = new Set<NodeId>();
    for (const op of ops) if (op.t === 'create') created.add(op.node.id);
    const out: Op[] = [], rootsByParent = new Map<ParentId, number[]>();
    for (const op of ops) {
        if (op.t === 'board' && op.key === 'host.paper') {
            // The growth was worked out from the paper it saw; a paper changed since (grown by a stroke, resized) is not that.
            if (doc.host !== basis.host) throw new InsertionStale('the paper changed');
            out.push(op); continue;
        }
        if (op.t === 'media') {
            if (op.op === 'add' && doc.media.has(op.entry.id)) throw new InsertionStale('a picture it adds is already on the board');
            if (op.op === 'set-file' && !doc.media.has(op.id)) throw new InsertionStale('a picture it uses was removed');
            out.push(op); continue;
        }
        if (op.t === 'set') {
            const node = doc.nodes.get(op.id);
            if (!node || isLocked(doc, node)) throw new InsertionStale('the item it changes was removed or locked');
            out.push(op); continue;
        }
        if (op.t !== 'create') { out.push(op); continue; }
        const node = op.node;
        if (doc.nodes.has(node.id)) throw new InsertionStale('an id it creates is taken');
        if (created.has(node.parent as NodeId)) { out.push({ t: 'create', node: release(doc, node, created) }); continue; }
        if (!isSheetParent(doc, node.parent)) {
            const parent = doc.nodes.get(node.parent as NodeId);
            if (!parent || parent.kind !== 'frame' || isLocked(doc, parent)) throw new InsertionStale('the frame it goes into was removed or locked');
        }
        let roots = rootsByParent.get(node.parent);
        if (!roots) rootsByParent.set(node.parent, roots = []);
        roots.push(out.length);
        out.push({ t: 'create', node: release(doc, node, created) });
    }
    // On top of what is there now, in the order they were prepared in.
    for (const [parent, indices] of rootsByParent) {
        const siblings = doc.children.get(parent) ?? [];
        const ordered = [...indices].sort((a, b) => compareOrder(createdNode(out[a]), createdNode(out[b])));
        const keys = keysBetween(siblings.at(-1)?.order ?? null, null, ordered.length);
        ordered.forEach((index, i) => { out[index] = { t: 'create', node: { ...createdNode(out[index]), order: keys[i] } as Node }; });
    }
    return out;
}
function createdNode(op: Op): Node {
    if (op.t !== 'create') throw new Error('Expected a create');
    return op.node;
}
/** An end bound to an item outside the insertion keeps its binding only while that item is still there, on the same sheet. */
function release(doc: BoardDoc, node: Node, created: ReadonlySet<NodeId>): Node {
    const sheet = () => sheetOf(doc, node.parent) ?? (created.has(node.parent as NodeId) ? undefined : node.parent);
    const keep = (attach: Attachment | null | undefined): boolean => {
        if (!attach || created.has(attach.target)) return true;
        const target = doc.nodes.get(attach.target);
        return !!target && target.kind !== 'connector' && target.kind !== 'group' && target.kind !== 'opaque'
            && (created.has(node.parent as NodeId) || sheetOf(doc, target.id) === sheet());
    };
    if (node.kind === 'connector') {
        if (keep(node.start.attach) && keep(node.end.attach)) return node;
        return { ...node, start: keep(node.start.attach) ? node.start : { ...node.start, attach: null },
            end: keep(node.end.attach) ? node.end : { ...node.end, attach: null } };
    }
    if (node.kind === 'polyline') {
        if (keep(node.startAttach) && keep(node.endAttach)) return node;
        return { ...node, ...(keep(node.startAttach) ? {} : { startAttach: null }), ...(keep(node.endAttach) ? {} : { endAttach: null }) };
    }
    return node;
}

/**
 * A paste selects what it pasted. One that lands after the person has chosen something else meanwhile (a box drawn, a click,
 * Escape, while it was being prepared) leaves their choice alone: the newer choice is theirs, and taking it away the moment
 * their box was let go undid the gesture they had just finished. `before` is the selection when the paste was asked for;
 * the selection object is replaced on every change of what is selected, and only then (selection.ts `publish`).
 */
export function selectLanded(current: SelectionSnapshot, before: SelectionSnapshot | undefined, select: () => void): void {
    if (before === undefined || current === before) select();
}
