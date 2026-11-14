import { isLocked } from '../change/commands';
import { selectedRootsAsync } from '../geom/selectedRootsAsync';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope } from './geometryScope';
import { prepareBoardLeafResize } from '../geom/runtimeResizeKinds';
import { prepareConnectorResize } from '../geom/runtimeConnectorResize';
import type { KindResizeFactors } from '../geom/resizeKinds.types';
import type { ResizePreview } from '../geom/transforms';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, sheetOf } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';

export interface StretchLeavesOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly axis: 'x' | 'y';
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
type Leaf = Exclude<Node, { kind: 'opaque' | 'group' | 'connector' }>;
type Lease = { release(): void };

/** Stretch uses each root's real kind rules, with one staged document and one history transaction. */
export async function stretchBoardLeaves(options: StretchLeavesOptions): Promise<void> {
    const { runtime, axis } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let font: number | undefined;
    const current = () => !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && runtime.selection.getSnapshot() === selection && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Stretch source changed', 'AbortError'); };
    if (axis !== 'x' && axis !== 'y') throw new RangeError('Invalid stretch axis');
    check(); const roots = await selectedRootsAsync(doc, options.ids, { signal, current, cooperate }); check(); if (!roots.length) return;
    for (const node of roots) if (node.kind === 'opaque' || isLocked(doc, node) || hasOpaqueDescendant(doc, node.id)
        || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Node cannot be stretched: ${node.id}`);
    const leaves = new Map<NodeId, NodeId[]>(), all = new Set<NodeId>(); let visited = 0;
    for (const root of roots) {
        const result: NodeId[] = [], pending = [root]; leaves.set(root.id, result);
        while (pending.length) {
            check(); const node = pending.pop()!;
            if (++visited % 256 === 0) { await cooperate(); check(); }
            if (node.locked) continue;
            if (node.kind === 'group') { for (const child of childrenOf(doc, node.id)) pending.push(child); }
            else { if (node.kind === 'opaque') throw new Error('Opaque content cannot be stretched'); result.push(node.id); all.add(node.id); }
        }
        if (!result.length) throw new Error(`Group has no stretchable content: ${root.id}`);
        all.add(root.id);
    }
    const scope = await acquireBoardGeometryScope(runtime, all, { signal, current, cooperate });
    const leases: Lease[] = [];
    try {
        check(); font = runtime.render.text.fonts.epoch;
        const boxes = new Map(roots.map(node => [node.id, scope.logicalBounds(node.id)] as const));
        let minimum = Infinity, maximum = -Infinity;
        for (const box of boxes.values()) {
            const start = axis === 'x' ? box.x : box.y, size = axis === 'x' ? box.width : box.height;
            minimum = Math.min(minimum, start); maximum = Math.max(maximum, start + size);
        }
        const span = maximum - minimum, targetCentre = (minimum + maximum) / 2;
        if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(targetCentre)) throw new RangeError('Stretch selection has no finite extent');
        let candidate = doc; const ops: NodeSetOp[] = [];
        const connectors: { id: NodeId; frame: ResizePreview; delta: { x: number; y: number } }[] = [];
        for (const root of roots) {
            check(); const box = boxes.get(root.id)!, size = axis === 'x' ? box.width : box.height;
            if (!(size > 0)) throw new RangeError('A zero-sized logical extent cannot be stretched');
            const factor = span / size, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
            const axes = new Map<NodeId, 'x' | 'y' | null>(); let aspect = false;
            for (const id of leaves.get(root.id)!) {
                const node = doc.nodes.get(id)!; const angle = scope.worldPose(id).rotation, quarter = Math.PI / 2, turns = Math.round(angle / quarter);
                const aligned = Math.abs(angle - turns * quarter) <= 8 * Number.EPSILON * Math.max(1, Math.abs(angle), Math.abs(turns * quarter));
                const swap = Math.abs(turns % 2) === 1;
                const localAxis = aligned ? (axis === 'x' ? (swap ? 'y' : 'x') : (swap ? 'x' : 'y')) : null;
                axes.set(id, localAxis);
                if (!aligned || node.kind === 'sticky' || node.kind === 'clip' || (node.kind === 'text' && localAxis === 'y')) aspect = true;
            }
            // Default, calibration cut by owner: arbitrary rotations or aspect-only descendants lock the whole root uniformly.
            const sx = axis === 'x' || aspect ? factor : 1, sy = axis === 'y' || aspect ? factor : 1;
            const delta = { x: axis === 'x' ? targetCentre - cx : 0, y: axis === 'y' ? targetCentre - cy : 0 };
            if (factor === 1 && delta.x === 0 && delta.y === 0) continue;
            const frame: ResizePreview = { box: { origin: { x: box.x, y: box.y }, width: box.width * sx, height: box.height * sy, rotation: 0 },
                scaleX: sx, scaleY: sy, signedWidth: box.width * sx, signedHeight: box.height * sy, anchor: { x: cx, y: cy } };
            for (const id of leaves.get(root.id)!) {
                check(); const node = candidate.nodes.get(id); if (!node || node.kind === 'opaque' || node.kind === 'group') throw new Error('Stretch node changed');
                if (node.kind === 'connector') { connectors.push({ id, frame, delta }); continue; }
                const b = scope.logicalBounds(id), px = b.x + b.width / 2, py = b.y + b.height / 2;
                const centreWorld = { x: cx + (px - cx) * sx + delta.x, y: cy + (py - cy) * sy + delta.y };
                const localAxis = axes.get(id), factors: KindResizeFactors = {
                    x: aspect || localAxis === 'x' ? factor : 1, y: aspect || localAxis === 'y' ? factor : 1,
                    zeroSignX: 1, zeroSignY: 1, handle: aspect && node.kind === 'text' ? 'corner' : 'side',
                    handleX: localAxis === 'x' ? 1 : 0, handleY: localAxis === 'y' ? 1 : 0, scope: 'multi' };
                const result = await prepareBoardLeafResize(node as Leaf, { runtime, doc: candidate, factors, centreWorld,
                    alignmentRotation: 0, signal, current, cooperate });
                leases.push(result); candidate = result.doc; ops.push(...result.kindOps, ...result.placementOps);
            }
        }
        // Default, calibration cut by owner: bound connectors resolve only after all selected targets.
        for (const item of connectors) {
            check(); const node = doc.nodes.get(item.id); if (!node || node.kind !== 'connector') throw new Error('Stretch connector changed');
            const result = await prepareConnectorResize({ runtime, source: doc, doc: candidate, node, frame: item.frame,
                translateWorld: item.delta, signal, current, cooperate });
            leases.push(result); candidate = result.doc; ops.push(...result.ops);
        }
        check(); if (ops.length) { const applied = session.apply({ origin: 'tool', label: axis === 'x' ? 'Stretch horizontal' : 'Stretch vertical', ops }); applied.release(); }
    } finally { try { for (let i = leases.length - 1; i >= 0; i--) leases[i].release(); } finally { scope.release(); } }
}
