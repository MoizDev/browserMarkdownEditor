import { nodeId, type NodeId } from '../../model/ids';
import type { Attachment, Point } from '../../model/nodes';
import type { ImportIssue } from '../report';
import { object, type LegacyObject } from './envelope';

export interface LegacyBinding { readonly id: string; readonly connector: NodeId; readonly terminal: 'start' | 'end'; readonly target: NodeId; readonly attachment: Attachment }
export function readBinding(record: LegacyObject): LegacyBinding {
    const props = object(record.props), anchor = object(props?.normalizedAnchor);
    if (record.typeName !== 'binding' || record.type !== 'arrow' || typeof record.id !== 'string'
        || typeof record.fromId !== 'string' || typeof record.toId !== 'string' || !props || !anchor
        || (props.terminal !== 'start' && props.terminal !== 'end')
        || typeof anchor.x !== 'number' || !Number.isFinite(anchor.x)
        || typeof anchor.y !== 'number' || !Number.isFinite(anchor.y)
        || typeof props.isExact !== 'boolean' || typeof props.isPrecise !== 'boolean') throw new Error('Invalid arrow binding');
    const snap = props.snap ?? 'none';
    if (snap !== 'none' && snap !== 'center' && snap !== 'edge-point' && snap !== 'edge') throw new Error('Unknown arrow snap mode');
    const target = nodeId(record.toId);
    return { id: record.id, connector: nodeId(record.fromId), terminal: props.terminal, target,
        attachment: { target, anchor: { x: anchor.x, y: anchor.y }, exact: props.isExact, precise: props.isPrecise, snap } };
}
export function resolveBinding(binding: LegacyBinding | undefined, nodes: ReadonlySet<NodeId>, stored: Point): {
    readonly end: Point & { readonly attach: Attachment | null }; readonly repair?: ImportIssue;
} {
    if (!binding) return { end: { ...stored, attach: null } };
    if (!nodes.has(binding.target)) return { end: { ...stored, attach: null },
        repair: { id: binding.id, reason: 'Missing binding target; endpoint kept free' } };
    return { end: { ...stored, attach: binding.attachment } };
}
