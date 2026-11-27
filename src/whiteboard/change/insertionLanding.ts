import { isLocked } from './commands';
import type { Op } from './ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import { isCancellation } from '../../platform/workers/envelope';
import type { NodeId, ParentId } from '../model/ids';
import type { Attachment, Node } from '../model/nodes';
import { compareOrder, keysBetween } from '../model/orderKey';
import type { SelectionSnapshot } from '../selection';

export class InsertionStale extends Error {
    constructor(reason: string) { super(`The board changed before the insertion landed: ${reason}`); this.name = 'InsertionStale'; }
}

export interface InsertionBasis {
    readonly doc: BoardDoc;
    readonly host: BoardDoc['host'];
}
export function insertionBasis(doc: BoardDoc): InsertionBasis { return { doc, host: doc.host }; }

export function rebaseInsertion(doc: BoardDoc, basis: InsertionBasis, ops: readonly Op[]): Op[] {
    if (doc !== basis.doc) throw new InsertionStale('the document was replaced');
    const created = new Set<NodeId>();
    for (const op of ops) if (op.t === 'create') created.add(op.node.id);
    const out: Op[] = [], rootsByParent = new Map<ParentId, number[]>();
    for (const op of ops) {
        if (op.t === 'board' && op.key === 'host.paper') {
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
    for (const [parent, indices] of rootsByParent) {
        const siblings = doc.children.get(parent) ?? [];
        const ordered = [...indices].sort((a, b) => compareOrder(createdNode(out[a]), createdNode(out[b])));
        const keys = keysBetween(siblings.at(-1)?.order ?? null, null, ordered.length);
        ordered.forEach((index, i) => { out[index] = { t: 'create', node: { ...createdNode(out[index]), order: keys[i] } as Node }; });
    }
    return out;
}
export function landedNodes(doc: BoardDoc, nodes: readonly Node[]): Node[] {
    const created = new Set<NodeId>(nodes.map(node => node.id)), rootsByParent = new Map<ParentId, number[]>();
    const out = nodes.map((node, index) => {
        if (!created.has(node.parent as NodeId)) {
            let roots = rootsByParent.get(node.parent);
            if (!roots) rootsByParent.set(node.parent, roots = []);
            roots.push(index);
        }
        return release(doc, node, created);
    });
    for (const [parent, indices] of rootsByParent) {
        const ordered = [...indices].sort((a, b) => compareOrder(out[a], out[b]));
        const keys = keysBetween(doc.children.get(parent)?.at(-1)?.order ?? null, null, ordered.length);
        ordered.forEach((index, i) => { out[index] = { ...out[index], order: keys[i] } as Node; });
    }
    return out;
}

const MEASURE_ATTEMPTS = 8;
export async function measureInsertion(runtime: BoardRuntime, ids: readonly NodeId[], build: () => BoardDoc, options: {
    readonly signal: AbortSignal; readonly check: () => void; readonly cooperate?: () => Promise<void>;
}): Promise<BoardGeometryScope> {
    for (let attempt = 1; ; attempt++) {
        options.check();
        const revision = runtime.session.doc.rev;
        try {
            return await acquireBoardGeometryScope(runtime, ids, { doc: build(), signal: options.signal,
                current: () => { options.check(); return true; }, cooperate: options.cooperate });
        } catch (error) {
            if (!isCancellation(error) || options.signal.aborted || runtime.session.doc.rev === revision) throw error;
            options.check();
            if (attempt >= MEASURE_ATTEMPTS) throw new InsertionStale('the board kept changing while it was measured');
        }
    }
}

function createdNode(op: Op): Node {
    if (op.t !== 'create') throw new Error('Expected a create');
    return op.node;
}
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

export function selectLanded(current: SelectionSnapshot, before: SelectionSnapshot | undefined, select: () => void): void {
    if (before === undefined || current === before) select();
}
