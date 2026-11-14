import { isLocked, selectedRoots } from '../change/commands';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope } from './geometryScope';
import { prepareBoardLeafResize, type BoardLeafResizeResult } from '../geom/runtimeResizeKinds';
import type { KindResizeFactors } from '../geom/resizeKinds.types';
import type { BoardRuntime } from '../host/runtime';
import { hasOpaqueDescendant, sheetOf } from '../model/doc';
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

/** Stretches representable leaf roots through their real kind/layout and staged-placement pipeline. */
export async function stretchBoardLeaves(options: StretchLeavesOptions): Promise<void> {
    const { runtime, axis } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    let font: number | undefined;
    const current = () => !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && runtime.selection.getSnapshot() === selection && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Stretch source changed', 'AbortError'); };
    if (axis !== 'x' && axis !== 'y') throw new RangeError('Invalid stretch axis');
    check(); const roots = selectedRoots(doc, options.ids);
    if (!roots.length) return;
    for (const node of roots) if (node.kind === 'opaque' || node.kind === 'group' || node.kind === 'connector'
        || isLocked(doc, node) || hasOpaqueDescendant(doc, node.id) || sheetOf(doc, node.id) !== selection.sheet)
        throw new Error(`Node requires a non-leaf stretch provider: ${node.id}`);
    const scope = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { signal, current, cooperate: options.cooperate });
    const leases: BoardLeafResizeResult[] = [];
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
        for (const root of roots) {
            check(); const node = candidate.nodes.get(root.id), box = boxes.get(root.id)!;
            if (!node || node.kind === 'opaque' || node.kind === 'group' || node.kind === 'connector') throw new Error('Stretch node changed');
            const size = axis === 'x' ? box.width : box.height;
            if (!(size > 0)) throw new RangeError('A zero-sized logical extent cannot be stretched');
            const factor = span / size, angle = scope.worldPose(root.id).rotation, quarter = Math.PI / 2;
            const turns = Math.round(angle / quarter), aligned = Math.abs(angle - turns * quarter) <= 8 * Number.EPSILON * Math.max(1, Math.abs(angle), Math.abs(turns * quarter));
            const swap = Math.abs(turns % 2) === 1, localAxis = aligned ? (axis === 'x' ? (swap ? 'y' : 'x') : (swap ? 'x' : 'y')) : null;
            // Default, calibration cut by owner: arbitrary rotations and aspect-only nodes use a uniform stretch.
            const uniform = !localAxis || node.kind === 'sticky' || node.kind === 'clip' || (node.kind === 'text' && localAxis === 'y');
            const factors: KindResizeFactors = { x: uniform || localAxis === 'x' ? factor : 1, y: uniform || localAxis === 'y' ? factor : 1,
                zeroSignX: 1, zeroSignY: 1, handle: uniform && node.kind === 'text' ? 'corner' : 'side',
                handleX: localAxis === 'x' ? 1 : 0, handleY: localAxis === 'y' ? 1 : 0, scope: 'multi' };
            const centreWorld = { x: axis === 'x' ? targetCentre : box.x + box.width / 2,
                y: axis === 'y' ? targetCentre : box.y + box.height / 2 };
            const result = await prepareBoardLeafResize(node as Exclude<Node, { kind: 'opaque' | 'group' | 'connector' }>, {
                runtime, doc: candidate, factors, centreWorld, signal, current, cooperate: options.cooperate,
            });
            leases.push(result); candidate = result.doc; ops.push(...result.kindOps, ...result.placementOps);
        }
        check(); if (ops.length) { const applied = session.apply({ origin: 'tool', label: axis === 'x' ? 'Stretch horizontal' : 'Stretch vertical', ops }); applied.release(); }
    } finally { try { for (let i = leases.length - 1; i >= 0; i--) leases[i].release(); } finally { scope.release(); } }
}
