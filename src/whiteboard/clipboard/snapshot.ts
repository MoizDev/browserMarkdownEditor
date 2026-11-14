import { encodeMedia, encodeNode, type EncoderContext } from '../format/encode';
import type { BoardDoc, BoardKind } from '../model/doc';
import { childrenOf, sheetOf } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node } from '../model/nodes';
import { scanRawMedia, visitNodeRaw } from '../model/rawMedia';
import type { RichFragment, RichText } from '../text/richText';
import type { ClipboardTextItem } from './rendition';

export interface ClipboardBounds { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface BoardPayload {
    readonly v: 1;
    readonly nonce: string;
    readonly from: { readonly board: string; readonly sheet: SheetId; readonly kind: BoardKind };
    readonly bounds: ClipboardBounds;
    readonly records: readonly string[];
    readonly media: Readonly<Record<string, string>>;
}
export interface ClipboardLease { release(): void }
export interface CopySnapshot {
    readonly roots: readonly NodeId[];
    readonly selected: readonly NodeId[];
    readonly skippedOpaque: readonly NodeId[];
    readonly nodes: readonly Node[];
    readonly payload: BoardPayload;
    readonly textItems: readonly ClipboardTextItem[];
    readonly media: readonly MediaEntry[];
    readonly leases: readonly ClipboardLease[];
}
export interface CopySnapshotHost {
    readonly doc: BoardDoc;
    readonly sheet: SheetId;
    readonly board: string;
    readonly encoder: EncoderContext;
    bounds(node: Node): ClipboardBounds;
    /** Root geometry is baked into sheet/page coordinates; the live node is never mutated. */
    detachRoot(node: Node, sheet: SheetId): Node;
    retainSample(node: Extract<Node, { kind: 'stroke' }>): ClipboardLease;
    retainMedia(id: MediaId): ClipboardLease;
}

function randomNonce(): string {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const bytes = new Uint8Array(32);
    let result = '';
    while (result.length < 16) {
        crypto.getRandomValues(bytes);
        for (const byte of bytes) {
            if (byte < 248) result += alphabet[byte % 62];
            if (result.length === 16) break;
        }
    }
    return result;
}
function textOf(node: Node): RichText | null {
    if (node.kind === 'text' || node.kind === 'sticky') return node.text;
    if (node.kind === 'figure' || node.kind === 'connector') return node.label;
    if (node.kind === 'frame' && node.name) return { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: node.name, marks: {} }] }] };
    return null;
}
function mediaOf(node: Node, ids: Set<MediaId>): void {
    if ((node.kind === 'picture' || node.kind === 'clip') && node.media) ids.add(node.media);
    if (node.kind === 'linkcard' && node.preview) {
        if (node.preview.image) ids.add(node.preview.image);
        if (node.preview.favicon) ids.add(node.preview.favicon);
    }
    visitNodeRaw(node, raw => scanRawMedia(raw, id => ids.add(id)));
}

export function snapshotTextSelection(host: CopySnapshotHost, fragment: RichFragment, node: Node, bounds: ClipboardBounds): CopySnapshot {
    if (!host.doc.sheets.has(host.sheet) || node.kind !== 'text' || node.parent !== host.sheet
        || node.text !== fragment || ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite)
        || bounds.w < 0 || bounds.h < 0) throw new Error('Invalid text clipboard snapshot');
    const encoded = encodeNode(node, host.doc, host.encoder);
    if (!encoded.ok) throw new Error(encoded.error.reason);
    return { roots: [], selected: [], skippedOpaque: [], nodes: [node], textItems: [{ text: fragment, bounds }], media: [], leases: [],
        payload: { v: 1, nonce: randomNonce(), from: { board: host.board, sheet: host.sheet, kind: host.doc.kind },
            bounds, records: [encoded.value.text], media: Object.create(null) as Record<string, string> } };
}

export function snapshotSelection(host: CopySnapshotHost, selection: readonly NodeId[]): CopySnapshot {
    if (!host.doc.sheets.has(host.sheet) || !host.board || host.board.length > 128) throw new Error('Invalid clipboard source');
    const chosen = new Set(selection);
    const roots: NodeId[] = [];
    for (const id of chosen) {
        const node = host.doc.nodes.get(id);
        if (!node || sheetOf(host.doc, id) !== host.sheet) throw new Error('Clipboard selection is stale');
        let parent = node.parent, nested = false;
        for (let depth = 0; depth < 64 && !host.doc.sheets.has(parent as SheetId); depth++) {
            if (chosen.has(parent as NodeId)) { nested = true; break; }
            const ancestor = host.doc.nodes.get(parent as NodeId);
            if (!ancestor) throw new Error('Invalid clipboard ancestry');
            parent = ancestor.parent;
        }
        if (!nested) roots.push(id);
    }
    if (!roots.length) throw new Error('Nothing selected');
    const nodes: Node[] = [], leases: ClipboardLease[] = [], ids = new Set<MediaId>();
    const skippedOpaque: NodeId[] = [], copiedRoots: NodeId[] = [];
    const texts: ClipboardTextItem[] = [];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    try {
        const stack = roots.slice().reverse().map(id => ({ id, root: true }));
        while (stack.length) {
            const { id, root } = stack.pop()!;
            const node = host.doc.nodes.get(id);
            if (!node) throw new Error('Clipboard selection changed');
            if (node.kind === 'opaque') { skippedOpaque.push(node.id); continue; }
            if (root) copiedRoots.push(node.id);
            if (nodes.length >= 100000) throw new RangeError('Too many selected nodes to copy');
            const bounds = host.bounds(node);
            if (![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w < 0 || bounds.h < 0) throw new Error('Invalid clipboard bounds');
            if (root) {
                left = Math.min(left, bounds.x); top = Math.min(top, bounds.y);
                right = Math.max(right, bounds.x + bounds.w); bottom = Math.max(bottom, bounds.y + bounds.h);
            }
            const copy = root ? host.detachRoot(node, host.sheet) : node;
            if (copy.id !== node.id || copy.kind !== node.kind || (root && copy.parent !== host.sheet)) throw new Error('Invalid clipboard root conversion');
            nodes.push(copy);
            if (node.kind === 'stroke') leases.push(host.retainSample(node));
            mediaOf(node, ids);
            const text = textOf(node);
            if (text) texts.push({ text, bounds });
            const children = childrenOf(host.doc, id);
            for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i].id, root: false });
        }
        if (!nodes.length) throw new Error(`This version can't copy opaque content: ${skippedOpaque.join(', ')}`);
        const records: string[] = [];
        for (const node of nodes) {
            const result = encodeNode(node, host.doc, host.encoder);
            if (!result.ok) throw new Error(result.error.reason);
            records.push(result.value.text);
        }
        const media: MediaEntry[] = [];
        for (const id of ids) {
            const entry = host.doc.media.get(id);
            if (!entry) continue;
            leases.push(host.retainMedia(id));
            const result = encodeMedia(entry);
            if (!result.ok) throw new Error(result.error.reason);
            records.push(result.value.text);
            media.push(entry);
        }
        return { roots: copiedRoots, selected: [...chosen], skippedOpaque, nodes, textItems: texts, media, leases,
            payload: { v: 1, nonce: randomNonce(), from: { board: host.board, sheet: host.sheet, kind: host.doc.kind },
                bounds: { x: left, y: top, w: right - left, h: bottom - top }, records, media: Object.create(null) as Record<string, string> } };
    } catch (error) {
        for (const lease of leases) lease.release();
        throw error;
    }
}
