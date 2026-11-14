import type { BoardDoc, BoardDocInput, OpaqueIndexedDoc, Sheet } from './doc';
import type { NodeId, ParentId, SheetId } from './ids';
import type { MediaEntry, MediaId } from './media';
import { createNode, type Node } from './nodes';
import { compareOrder } from './orderKey';

// Loading can encounter a million siblings; native sort and index construction
// must not monopolize the admission worker between cancellation checks.
export async function createLoadedBoardDoc(input: BoardDocInput, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<BoardDoc> {
    let work = 0;
    const tick = async () => {
        if (signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
        if (cooperate) await cooperate();
        if (signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
    };
    const due = () => (work++ & 1023) === 0;
    const sort = async <T extends { readonly order: string; readonly id: string }>(values: T[]) => {
        if (values.length < 2) return;
        let source = values, target = new Array<T>(values.length);
        for (let width = 1; width < values.length; width *= 2) {
            for (let start = 0; start < values.length; start += width * 2) {
                const mid = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
                let left = start, right = mid;
                for (let i = start; i < end; i++) {
                    if (due()) await tick();
                    target[i] = right >= end || (left < mid && compareOrder(source[left], source[right]) <= 0)
                        ? source[left++] : source[right++];
                }
            }
            [source, target] = [target, source];
        }
        if (source !== values) {
            for (let i = 0; i < values.length; i++) {
                if (due()) await tick();
                values[i] = source[i];
            }
        }
    };
    const sheets = new Map<SheetId, Sheet>(), nodes = new Map<NodeId, Node>(), media = new Map<MediaId, MediaEntry>();
    const sheetOrder: Sheet[] = [], children = new Map<ParentId, Node[]>();
    const attachedTo = new Map<NodeId, Set<NodeId>>(), bySheet = new Map<SheetId, Set<NodeId>>();
    const byPage = new Map<number, Set<NodeId>>(), mediaRefs = new Map<MediaId, Set<NodeId>>();
    const preservedMediaRefs = new Map<MediaId, number>(), opaqueDescendants = new Map<ParentId, number>();
    const doc: OpaqueIndexedDoc = {
        kind: input.kind, sheets, nodes, media, sheetOrder, children, attachedTo, bySheet, byPage, mediaRefs,
        preservedMediaRefs, opaqueDescendants, ui: input.ui, view: input.view, host: input.host, preserved: input.preserved, rev: 0,
    };
    const addMember = <K>(index: Map<K, Set<NodeId>>, key: K, id: NodeId) => {
        let members = index.get(key);
        if (!members) index.set(key, members = new Set());
        members.add(id);
    };
    await tick();
    for (const [id, count] of input.preservedMediaRefs) {
        if (due()) await tick();
        preservedMediaRefs.set(id, count);
    }
    for (const record of input.sheets) {
        if (due()) await tick();
        const sheet = { id: record.id, name: record.name, order: record.order, ext: record.ext };
        sheets.set(sheet.id, sheet); sheetOrder.push(sheet);
    }
    await sort(sheetOrder);
    for (const record of input.nodes ?? []) {
        if (due()) await tick();
        const node = createNode(record);
        nodes.set(node.id, node);
        let siblings = children.get(node.parent);
        if (!siblings) children.set(node.parent, siblings = []);
        siblings.push(node);
    }
    for (const siblings of children.values()) {
        if (due()) await tick();
        if (siblings.length > 1) await sort(siblings);
    }
    for (const node of nodes.values()) {
        if (due()) await tick();
        let current: ParentId = node.id;
        for (let depth = 0; depth <= 64; depth++) {
            if (due()) await tick();
            if (sheets.has(current as SheetId)) { addMember(bySheet, current as SheetId, node.id); break; }
            const ancestor = nodes.get(current as NodeId);
            if (!ancestor) break;
            current = ancestor.parent;
        }
        if (input.kind !== 'whiteboard' && sheets.has(node.parent as SheetId)) addMember(byPage, node.page, node.id);
        if (node.kind === 'opaque') {
            let parent = node.parent;
            for (let depth = 0; depth <= 64; depth++) {
                if (due()) await tick();
                opaqueDescendants.set(parent, (opaqueDescendants.get(parent) ?? 0) + 1);
                if (sheets.has(parent as SheetId)) break;
                const container = nodes.get(parent as NodeId);
                if (!container) break;
                parent = container.parent;
            }
        }
        if (node.kind === 'connector') {
            if (node.start.attach) addMember(attachedTo, node.start.attach.target, node.id);
            if (node.end.attach) addMember(attachedTo, node.end.attach.target, node.id);
        }
        if ((node.kind === 'picture' || node.kind === 'clip') && node.media) addMember(mediaRefs, node.media, node.id);
        if (node.kind === 'linkcard' && node.preview) {
            if (node.preview.image) addMember(mediaRefs, node.preview.image, node.id);
            if (node.preview.favicon) addMember(mediaRefs, node.preview.favicon, node.id);
        }
    }
    for (const entry of input.media ?? []) {
        if (due()) await tick();
        media.set(entry.id, entry);
    }
    await tick();
    return doc;
}
