import { pageAt } from '../../platform/render/pageStack';
import type { ChangeGeometry } from '../change/coordinates';
import type { CommandBuilder } from '../change/ops';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { boardPageStack } from '../model/pages';
import { AgentOpRefused } from './errors';

// F-AGENT-007: root ownership follows the geometric centre (a gap belongs to
// the following page). Reanchoring preserves the exact world pose and remains
// inside the operation's savepoint, including any just-staged paper growth.
export function reanchorAgentRoot(doc: BoardDoc, builder: CommandBuilder, id: NodeId, geometry: ChangeGeometry): void {
    const node = doc.nodes.get(id);
    if (!node || doc.kind === 'whiteboard' || !isSheetParent(doc, node.parent)) return;
    const stack = boardPageStack(doc.host);
    if (!stack?.rects.length || !stack.rects[node.page]) throw new AgentOpRefused('page geometry is unavailable');
    const center = geometry.worldBoundsCenter(doc, node);
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) throw new AgentOpRefused('shape bounds are unavailable');
    const page = pageAt(stack, center.y);
    if (page === node.page) return;
    const before = stack.rects[node.page], after = stack.rects[page];
    builder.push({ t: 'set', id, key: 'page', value: page });
    builder.push({ t: 'set', id, key: 'x', value: node.x + before.x - after.x });
    builder.push({ t: 'set', id, key: 'y', value: node.y + before.y - after.y });
}
