import { figureLabelRequest, frameTitleRequest, stickyLabelRequest } from '../../geom/providers';
import type { EditableTextRequest } from './bindingTypes';

// The text-size table is the plan's default host metric; zoom never changes layout.
const TEXT_SIZE = { s: 18, m: 24, l: 36, xl: 44 } as const;
const LABEL_SIZE = { s: 18, m: 22, l: 26, xl: 32 } as const;
const zero = { top: 0, right: 0, bottom: 0, left: 0 } as const;

/** Resolve the same host constraints for normal paint, edit overlay, and growY. */
export const editableTextRequest: EditableTextRequest = (node, text, options) => {
    const { revision, fontEpoch, zoom } = options;
    if (node.kind === 'text') return {
        text, revision, fontEpoch, width: node.autoSize ? null : node.w,
        style: { font: node.font, size: TEXT_SIZE[node.size], ink: { swatch: node.color, role: 'text' },
            align: node.align, verticalAlign: 'start', padding: zero, minHeight: 0, overflow: 'allow' },
    };
    if (node.kind === 'sticky') return stickyLabelRequest({ ...node, text }, revision, fontEpoch).request;
    if (node.kind === 'figure') return figureLabelRequest({ ...node, label: text }, revision, fontEpoch)!.request;
    if (node.kind === 'connector') {
        if (!Number.isFinite(options.connectorLength) || options.connectorLength! < 0) throw new RangeError('Connector label needs its path length');
        return { text, revision, fontEpoch, width: Math.max(64, options.connectorLength! / 2),
            style: { font: node.font, size: LABEL_SIZE[node.size] * node.labelScale,
                ink: { swatch: node.labelColor, role: 'label' }, align: 'middle', verticalAlign: 'middle',
                padding: zero, minHeight: 0, overflow: 'grapheme' } };
    }
    if (node.kind === 'frame') return { ...frameTitleRequest(node, '', revision, fontEpoch, zoom), text };
    throw new TypeError('Node has no editable text');
};
