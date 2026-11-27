import { newNodeId } from '../../model/ids';
import { createText, type TextNode } from '../../model/nodes';
import type { Transaction } from '../../change/ops';
import { keyBetween } from '../../model/orderKey';
import { EMPTY_RICH_TEXT, plainRichText } from '../richText';
import type { TextCreationPorts } from './managerTypes';

const ALIGN_OFFSET: Readonly<Record<string, number>> = { start: 0, middle: 10, end: 20 };

export function textCreation(ports: TextCreationPorts): (x: number, y: number, width: number | null, seed?: string) => { readonly node: TextNode; readonly transaction: Transaction } {
    return (x, y, width, seed) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || (width !== null && (!Number.isFinite(width) || width <= 0))) throw new RangeError('Invalid text creation geometry');
        const zoom = ports.zoom();
        if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError('Invalid text creation zoom');
        const { doc } = ports;
        const scale = Math.max(0.01, Math.min(100, doc.ui.penWidth / 3 / (ports.dynamicSize() ? zoom : 1)));
        const line = width === null ? ports.lineHeight() : null;
        const anchor = width === null ? { x: x - ALIGN_OFFSET[doc.ui.next.textAlign] * scale, y: y - (line ?? 0) * scale / 2 } : { x, y };
        const placed = ports.place(anchor.x, anchor.y), siblings = doc.children.get(placed.parent) ?? [];
        const node = createText({ id: newNodeId(doc), parent: placed.parent, order: keyBetween(siblings[siblings.length - 1]?.order ?? null, null),
            page: placed.page, x: placed.x, y: placed.y, ext: null, text: seed ? plainRichText(seed) : EMPTY_RICH_TEXT,
            color: doc.ui.next.color, size: doc.ui.next.size, font: doc.ui.next.font, align: doc.ui.next.textAlign,
            autoSize: width === null, w: width === null ? 1 : Math.max(1, Math.min(1_000_000, width / scale)), scale });
        return { node, transaction: { origin: 'tool', label: 'Create text', ops: [...(placed.before ?? []), { t: 'create', node }] } };
    };
}
