import { snapshotTextSelection, type ClipboardBounds, type CopySnapshot, type CopySnapshotHost } from '../clipboard/snapshot';
import { newNodeId } from '../model/ids';
import { createText, type Node } from '../model/nodes';
import { keyBetween } from '../model/orderKey';
import type { EditSelection } from './edit/host';
import type { RichFragment } from './richText';

/** A text range copies as one synthetic text node, while the original node stays untouched. */
export function snapshotCopiedTextRange(host: CopySnapshotHost, original: Node, selection: EditSelection,
    fragment: RichFragment, bounds: ClipboardBounds): CopySnapshot {
    if (selection.anchor === selection.focus || !host.doc.nodes.has(original.id)) throw new Error('There is no text range to copy');
    const defaults = host.doc.ui.next;
    const styled = original.kind === 'text' || original.kind === 'sticky' || original.kind === 'figure' || original.kind === 'connector';
    const color = original.kind === 'text' ? original.color
        : original.kind === 'sticky' || original.kind === 'figure' || original.kind === 'connector' ? original.labelColor : defaults.color;
    const scale = original.kind === 'text' || original.kind === 'sticky' ? original.scale
        : original.kind === 'figure' || original.kind === 'connector' ? original.labelScale : 1;
    const node = createText({ id: newNodeId(host.doc), parent: host.sheet, order: keyBetween(null, null), page: -1,
        x: bounds.x, y: bounds.y, ext: null, text: fragment, color,
        size: styled ? original.size : defaults.size, font: styled ? original.font : defaults.font,
        align: original.kind === 'text' ? original.align : defaults.textAlign,
        autoSize: true, w: Math.max(1, bounds.w / scale), scale });
    // Clipboard records are always world-rooted, even when their source host is paged.
    const syntheticHost: CopySnapshotHost = { ...host, doc: { ...host.doc, kind: 'whiteboard' },
        encoder: { ...host.encoder, bounds: candidate => candidate.id === node.id
            ? [bounds.x, bounds.y, bounds.w, bounds.h] : host.encoder.bounds(candidate) } };
    const snapshot = snapshotTextSelection(syntheticHost, fragment, node, bounds,
        { node: original.id, anchor: selection.anchor, focus: selection.focus });
    return { ...snapshot, payload: { ...snapshot.payload, from: { ...snapshot.payload.from, kind: host.doc.kind } } };
}
