import { newNodeId } from '../../model/ids';
import { createText, type TextNode } from '../../model/nodes';
import type { Transaction } from '../../change/ops';
import { keyBetween } from '../../model/orderKey';
import { EMPTY_RICH_TEXT } from '../richText';
import type { TextCreationPorts } from './managerTypes';

/** Create once through the shared transaction path; page growth precedes the node. */
export function textCreation(ports: TextCreationPorts): (x: number, y: number, width: number | null) => { readonly node: TextNode; readonly transaction: Transaction } {
    return (x, y, width) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || (width !== null && (!Number.isFinite(width) || width <= 0))) throw new RangeError('Invalid text creation geometry');
        const place = ports.place(x, y), zoom = ports.zoom();
        if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError('Invalid text creation zoom');
        const { doc } = ports, siblings = doc.children.get(place.parent) ?? [];
        const scale = Math.max(0.01, Math.min(100, doc.ui.penWidth / 3 / (ports.dynamicSize() ? zoom : 1)));
        const node = createText({ id: newNodeId(doc), parent: place.parent, order: keyBetween(siblings[siblings.length - 1]?.order ?? null, null),
            page: place.page, x: place.x, y: place.y, ext: null, text: EMPTY_RICH_TEXT,
            color: doc.ui.next.color, size: doc.ui.next.size, font: doc.ui.next.font, align: doc.ui.next.textAlign,
            autoSize: width === null, w: width === null ? 1 : Math.max(1, Math.min(1_000_000, width / scale)), scale });
        return { node, transaction: { origin: 'tool', label: 'Create text', ops: [...(place.before ?? []), { t: 'create', node }] } };
    };
}
