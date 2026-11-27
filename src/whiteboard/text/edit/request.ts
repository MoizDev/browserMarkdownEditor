import { figureLabelRequest, frameTitleRequest, stickyLabelRequest } from '../../geom/providers';
import type { EditableTextRequest } from './bindingTypes';
import type { RichText } from '../richText';

const TEXT_SIZE = { s: 18, m: 24, l: 36, xl: 44 } as const;
const CONNECTOR_LABEL_SIZE = { s: 18, m: 20, l: 24, xl: 28 } as const;
const zero = { top: 0, right: 0, bottom: 0, left: 0 } as const;
const frameTitles = new WeakMap<object, RichText>();

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
            style: { font: node.font, size: CONNECTOR_LABEL_SIZE[node.size] * node.labelScale,
                ink: { swatch: node.labelColor, role: 'label' }, align: 'middle', verticalAlign: 'middle',
                padding: zero, minHeight: 0, overflow: 'grapheme' } };
    }
    if (node.kind === 'frame') {
        const block = text.blocks[0], run = block?.runs[0];
        const simple = text.blocks.length === 1 && !!block && !!run && block.kind === 'p' && block.level === 0 && block.dir === 'auto'
            && block.start === undefined && block.runs.length === 1 && run.text === node.name
            && !block.tail && !block.carriers?.length && !run.tail && Object.keys(run.marks).length === 0;
        if (simple) {
            const cached = frameTitles.get(node);
            if (cached) text = cached; else frameTitles.set(node, text);
        }
        return { ...frameTitleRequest(node, '', revision, fontEpoch, zoom), text };
    }
    throw new TypeError('Node has no editable text');
};
