import { snapshotTextSelection, type ClipboardBounds, type CopySnapshot, type CopySnapshotHost } from '../clipboard/snapshot';
import { newNodeId } from '../model/ids';
import { createText, type Node } from '../model/nodes';
import { keyBetween } from '../model/orderKey';
import type { EditSelection } from './edit/host';
import type { RichFragment } from './richText';

/** A text range copies as one synthetic text node, while the original node stays untouched. */
export type TextCopySnapshotHost = Pick<CopySnapshotHost, 'doc' | 'sheet' | 'board' | 'encoder'>;

export function snapshotCopiedTextRange(host: TextCopySnapshotHost, original: Node, selection: EditSelection,
    fragment: RichFragment, bounds: ClipboardBounds): CopySnapshot {
    if (selection.anchor === selection.focus || !host.doc.nodes.has(original.id)) throw new Error('There is no text range to copy');
    const defaults = host.doc.ui.next;
    const styled = original.kind === 'text' || original.kind === 'sticky' || original.kind === 'figure' || original.kind === 'connector';
    const color = original.kind === 'text' ? original.color
        : original.kind === 'sticky' || original.kind === 'figure' || original.kind === 'connector' ? original.labelColor
            : original.kind === 'frame' ? original.color ?? 'black' : defaults.color;
    const textSize = { s: 18, m: 24, l: 36, xl: 44 } as const;
    const labelSize = { s: 18, m: 22, l: 26, xl: 32 } as const;
    const connectorSize = { s: 18, m: 20, l: 24, xl: 28 } as const;
    const scale = Math.max(0.01, Math.min(100, original.kind === 'text' ? original.scale
        : original.kind === 'sticky' ? original.scale * (original.fit ?? 1) * labelSize[original.size] / textSize[original.size]
            : original.kind === 'figure' ? original.labelScale * labelSize[original.size] / textSize[original.size]
                : original.kind === 'connector' ? original.labelScale * connectorSize[original.size] / textSize[original.size]
                    : original.kind === 'frame' ? 12 / textSize.s : 1));
    const node = createText({ id: newNodeId(host.doc), parent: host.sheet, order: keyBetween(null, null), page: -1,
        x: bounds.x, y: bounds.y, ext: null, text: fragment, color,
        size: styled ? original.size : original.kind === 'frame' ? 's' : defaults.size,
        font: styled ? original.font : original.kind === 'frame' ? 'sans' : defaults.font,
        align: original.kind === 'text' ? original.align : original.kind === 'frame' ? 'start' : defaults.textAlign,
        autoSize: true, w: Math.max(1, bounds.w / scale), scale });
    // Clipboard records are always world-rooted, even when their source host is paged.
    const syntheticHost: TextCopySnapshotHost = { ...host, doc: { ...host.doc, kind: 'whiteboard' },
        encoder: { ...host.encoder, bounds: candidate => candidate.id === node.id
            ? [bounds.x, bounds.y, bounds.w, bounds.h] : host.encoder.bounds(candidate) } };
    const snapshot = snapshotTextSelection(syntheticHost, fragment, node, bounds,
        { node: original.id, anchor: selection.anchor, focus: selection.focus });
    return { ...snapshot, payload: { ...snapshot.payload, from: { ...snapshot.payload.from, kind: host.doc.kind } } };
}
