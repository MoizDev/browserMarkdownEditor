import type { NodeSetOp } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { OrderKey } from '../model/orderKey';
import { projectBoardGeometrySets, type BoardGeometryProjectionOptions } from '../model/overlayDoc';
import { projectGeometryReparents, type GeometryReparent } from './reparentProjection';
import { yieldToHost } from '../../platform/yieldToHost';

/** Project the exact operation sequence emitted by a staged transform, including
 * its trailing frame-membership reparents. The base stays pinned by the caller. */
export async function projectBoardTransformPreview(base: BoardDoc, ops: readonly NodeSetOp[],
    options: BoardGeometryProjectionOptions): Promise<BoardDoc> {
    const signal = options.signal, revision = base.rev, host = base.host;
    const cooperate = options.cooperate ?? yieldToHost;
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || base.rev !== revision || base.host !== host) throw new DOMException('Transform preview became stale', 'AbortError');
    };
    let firstParent = -1, work = 0; const prelude: NodeSetOp[] = [];
    for (let i = 0; i < ops.length; i++) {
        check(); if (ops[i].key === 'parent') { firstParent = i; break; }
        prelude.push(ops[i]);
        if (++work % 256 === 0) { await cooperate(); check(); }
    }
    if (firstParent < 0) return projectBoardGeometrySets(base, ops, options);
    const staged = await projectBoardGeometrySets(base, prelude, options); check();
    type MutableChange = { id: NodeId; parent: ParentId; page: number; x: number; y: number; rotation: number; order: OrderKey };
    const changes = new Map<NodeId, MutableChange>();
    for (let i = firstParent; i < ops.length; i++) {
        check(); const op = ops[i];
        let change = changes.get(op.id);
        if (!change) {
            if (op.key !== 'parent') throw new Error('Transform preview has a non-reparent operation after its membership phase');
            const node = staged.nodes.get(op.id); if (!node || node.kind === 'opaque') throw new Error('Transform preview root disappeared');
            change = { id: node.id, parent: node.parent, page: node.page, x: node.x, y: node.y, rotation: node.rotation, order: node.order };
            changes.set(node.id, change);
        }
        switch (op.key) {
            case 'parent': change.parent = op.value; break;
            case 'page': change.page = op.value; break;
            case 'x': change.x = op.value; break;
            case 'y': change.y = op.value; break;
            case 'rotation': change.rotation = op.value; break;
            case 'order': change.order = op.value; break;
            default: throw new Error('Transform membership phase contains an unsupported operation');
        }
        if (++work % 256 === 0) { await cooperate(); check(); }
    }
    const roots: GeometryReparent[] = [];
    for (const change of changes.values()) { roots.push(change); if (++work % 256 === 0) { await cooperate(); check(); } }
    const projected = await projectGeometryReparents(staged, roots, { signal, current: options.current, cooperate });
    check(); return projected;
}
