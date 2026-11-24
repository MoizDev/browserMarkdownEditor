import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from './geometryScope';
import { inspectOpaqueSubtrees } from './selectionScope';
import { inverse } from '../geom/affine';
import type { Box } from '../geom/bounds';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, sheetOf } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';

export interface FitFrameOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    /** Which sides of the frame the fit may move: a frame's edge fits its own axis, a corner (and the menu) both. */
    readonly axes?: 'both' | 'x' | 'y';
}
export interface FrameFitPlan {
    readonly ops: readonly NodeSetOp[];
    readonly doc: BoardRuntime['session']['doc'];
    commit(): void;
    cancel(): void;
}

/** Prepare a frame fit without touching live indexes. Source and projected
 * geometry stay pinned until its one commit or explicit cancellation. */
export async function prepareBoardFrameFit(options: FitFrameOptions): Promise<FrameFitPlan> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let font: number | undefined, released = false, source: BoardGeometryScope | undefined, final: BoardGeometryScope | undefined;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && !session.isGestureActive && runtime.selection.getSnapshot() === selection
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Frame fit became stale', 'AbortError'); };
    const release = () => {
        if (released) return; released = true;
        try { final?.release(); } finally { source?.release(); }
        final = source = undefined;
    };
    const plan = (ops: readonly NodeSetOp[], projected: BoardRuntime['session']['doc']): FrameFitPlan => {
        const frozen = Object.freeze(ops);
        return Object.freeze({ ops: frozen, doc: projected,
            commit() {
                try {
                    check();
                    if (frozen.length) { const applied = session.apply({ origin: 'tool', label: 'Fit frame to content', ops: frozen }); applied.release(); }
                } finally { release(); }
            },
            cancel: release,
        });
    };
    let work = 0, started = performance.now();
    const tick = async () => {
        if (++work >= 256 || performance.now() - started >= 3) { check(); await cooperate(); check(); work = 0; started = performance.now(); }
    };
    try {
        check(); const frame = doc.nodes.get(options.id);
        if (!frame || frame.kind !== 'frame' || isLocked(doc, frame) || sheetOf(doc, frame.id) !== selection.sheet)
            throw new Error('Frame fit requires an editable frame');
        const opaque = await inspectOpaqueSubtrees(doc, [frame.id], { signal, current, cooperate }); check();
        if (opaque.get(frame.id)) throw new Error('Frame fit cannot restructure opaque content');
        const children: Node[] = [], ids: NodeId[] = [frame.id];
        for (const child of childrenOf(doc, frame.id)) { children.push(child); ids.push(child.id); await tick(); }
        check(); if (!children.length) return plan([], doc);
        source = await acquireBoardGeometryScope(runtime, ids, { signal, current, cooperate });
        check(); font = runtime.render.text.fonts.epoch;
        const pose = worldPose(doc, frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        const frameFromWorld = inverse([c, s, -s, c, pose.x, pose.y], 1e12);
        if (!frameFromWorld) throw new Error('Frame transform is not invertible');
        let bounds: Box | null = null;
        for (const child of children) {
            const next = await source.boundsInSpace(child.id, frameFromWorld); check();
            bounds = bounds ? [Math.min(bounds[0], next[0]), Math.min(bounds[1], next[1]), Math.max(bounds[2], next[2]), Math.max(bounds[3], next[3])] : next;
            await tick();
        }
        if (!bounds) return plan([], doc);
        // Default, calibration cut by owner: fitting uses 50 world units on every side.
        const fitX = options.axes !== 'y', fitY = options.axes !== 'x';
        const left = fitX ? bounds[0] - 50 : 0, width = fitX ? bounds[2] - bounds[0] + 100 : frame.w;
        const top = fitY ? bounds[1] - 50 : 0, height = fitY ? bounds[3] - bounds[1] + 100 : frame.h;
        if (![left, top, width, height].every(Number.isFinite) || width < 1 || height < 1 || width > 1_000_000 || height > 1_000_000)
            throw new RangeError('Fitted frame exceeds model bounds');
        const cr = Math.cos(frame.rotation), sr = Math.sin(frame.rotation), x = frame.x + cr * left - sr * top, y = frame.y + sr * left + cr * top;
        if (![x, y].every(Number.isFinite)) throw new RangeError('Fitted frame position overflows');
        const ops: NodeSetOp[] = [{ t: 'set', id: frame.id, key: 'x', value: x }, { t: 'set', id: frame.id, key: 'y', value: y },
            { t: 'set', id: frame.id, key: 'w', value: width }, { t: 'set', id: frame.id, key: 'h', value: height }];
        for (const child of children) {
            if (left) ops.push({ t: 'set', id: child.id, key: 'x', value: child.x - left });
            if (top) ops.push({ t: 'set', id: child.id, key: 'y', value: child.y - top });
            await tick();
        }
        const candidate = await projectBoardGeometrySets(doc, ops, { signal, current, cooperate }); check();
        const staged = await acquireBoardGeometryScope(runtime, [frame.id], { doc: candidate, signal, current, cooperate });
        try {
            check(); const b = staged.logicalBounds(frame.id), world = worldPose(candidate, frame.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) };
            const placement = poseInParent(doc, frame, frame.parent, world, geometry);
            if (placement.page !== frame.page) ops.push({ t: 'set', id: frame.id, key: 'page', value: placement.page });
            ops.push({ t: 'set', id: frame.id, key: 'x', value: placement.x }, { t: 'set', id: frame.id, key: 'y', value: placement.y });
            const seen = new Set<string>(), reverse: NodeSetOp[] = [];
            for (let i = ops.length - 1; i >= 0; i--) {
                const op = ops[i], key = JSON.stringify([op.id, op.key]);
                if (!seen.has(key)) {
                    seen.add(key); const original = doc.nodes.get(op.id); if (!original) throw new Error('Fitted frame content disappeared');
                    if (!Object.is(Reflect.get(original, op.key), op.value)) reverse.push(op);
                }
                await tick();
            }
            const changed: NodeSetOp[] = [];
            for (let i = reverse.length - 1; i >= 0; i--) { changed.push(Object.freeze(reverse[i])); await tick(); }
            if (!changed.length) return plan([], doc);
            const projected = await projectBoardGeometrySets(doc, changed, { signal, current, cooperate }); check();
            final = await acquireBoardGeometryScope(runtime, [frame.id], { doc: projected, signal, current, cooperate }); check();
            return plan(changed, projected);
        } finally { staged.release(); }
    } catch (error) { release(); throw error; }
}

/** Backwards-compatible immediate command; preview clients can hold the plan. */
export async function fitBoardFrameToContent(options: FitFrameOptions): Promise<void> {
    const plan = await prepareBoardFrameFit(options);
    plan.commit();
}
