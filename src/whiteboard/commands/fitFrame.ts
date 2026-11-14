import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope } from './geometryScope';
import { inverse } from '../geom/affine';
import type { Box } from '../geom/bounds';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, sheetOf } from '../model/doc';
import type { NodeId } from '../model/ids';
import { projectBoardGeometrySets } from '../model/overlayDoc';

export interface FitFrameOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}

/** Fits the boundary in frame-local coordinates while every child's world pose stays fixed. */
export async function fitBoardFrameToContent(options: FitFrameOptions): Promise<void> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    let font: number | undefined;
    const current = () => !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && runtime.selection.getSnapshot() === selection && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Frame fit became stale', 'AbortError'); };
    check(); const frame = doc.nodes.get(options.id);
    if (!frame || frame.kind !== 'frame' || isLocked(doc, frame) || hasOpaqueDescendant(doc, frame.id)
        || sheetOf(doc, frame.id) !== selection.sheet) throw new Error('Frame fit requires an editable frame');
    const children = [...childrenOf(doc, frame.id)]; if (!children.length) return;
    const scope = await acquireBoardGeometryScope(runtime, [frame.id, ...children.map(child => child.id)], { signal, current, cooperate: options.cooperate });
    try {
        check(); font = runtime.render.text.fonts.epoch;
        const pose = worldPose(doc, frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        const frameFromWorld = inverse([c, s, -s, c, pose.x, pose.y], 1e12);
        if (!frameFromWorld) throw new Error('Frame transform is not invertible');
        let bounds: Box | null = null;
        for (const child of children) {
            const b = await scope.boundsInSpace(child.id, frameFromWorld); check();
            bounds = bounds ? [Math.min(bounds[0], b[0]), Math.min(bounds[1], b[1]), Math.max(bounds[2], b[2]), Math.max(bounds[3], b[3])] : b;
        }
        if (!bounds) return;
        // Default, calibration cut by owner: fitting uses 50 world units on every side.
        const left = bounds[0] - 50, top = bounds[1] - 50, width = bounds[2] - bounds[0] + 100, height = bounds[3] - bounds[1] + 100;
        if (![left, top, width, height].every(Number.isFinite) || width < 1 || height < 1 || width > 1_000_000 || height > 1_000_000)
            throw new RangeError('Fitted frame exceeds model bounds');
        const rotation = frame.rotation, cr = Math.cos(rotation), sr = Math.sin(rotation);
        const ops: NodeSetOp[] = [
            { t: 'set', id: frame.id, key: 'x', value: frame.x + cr * left - sr * top },
            { t: 'set', id: frame.id, key: 'y', value: frame.y + sr * left + cr * top },
            { t: 'set', id: frame.id, key: 'w', value: width }, { t: 'set', id: frame.id, key: 'h', value: height },
        ];
        for (const child of children) {
            if (left) ops.push({ t: 'set', id: child.id, key: 'x', value: child.x - left });
            if (top) ops.push({ t: 'set', id: child.id, key: 'y', value: child.y - top });
        }
        const candidate = await projectBoardGeometrySets(doc, ops, { signal, current, cooperate: options.cooperate }); check();
        const staged = await acquireBoardGeometryScope(runtime, [frame.id], { doc: candidate, signal, current, cooperate: options.cooperate });
        try {
            check(); const b = staged.logicalBounds(frame.id), world = worldPose(candidate, frame.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) };
            const placement = poseInParent(doc, frame, frame.parent, world, geometry);
            if (placement.page !== frame.page) ops.push({ t: 'set', id: frame.id, key: 'page', value: placement.page });
            ops.push({ t: 'set', id: frame.id, key: 'x', value: placement.x }, { t: 'set', id: frame.id, key: 'y', value: placement.y });
            const finalDoc = await projectBoardGeometrySets(doc, ops, { signal, current, cooperate: options.cooperate }); check();
            const final = await acquireBoardGeometryScope(runtime, [frame.id], { doc: finalDoc, signal, current, cooperate: options.cooperate });
            try { check(); const applied = session.apply({ origin: 'tool', label: 'Fit frame to content', ops }); applied.release(); }
            finally { final.release(); }
        } finally { staged.release(); }
    } finally { scope.release(); }
}
