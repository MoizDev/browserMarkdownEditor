import { selectedRootsAsync } from '../geom/selectedRootsAsync';
import { acquireBoardGeometryScope } from './geometryScope';
import { createBoardLeafResizePlan } from '../geom/runtimeLeafPlan';
import { createBoardRotationPlan } from '../geom/runtimeTransforms';
import { createBoardTranslationPlan } from '../geom/runtimeTranslation';
import { nextDown, nextUp } from '../geom/numeric';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';

export interface BoardKeyboardTransformOptions {
    readonly runtime: BoardRuntime;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}

/** Keyboard transforms use the same immutable plans and single-transaction commit as gestures. */
export function createBoardKeyboardTransforms(options: BoardKeyboardTransformOptions) {
    const { runtime } = options;
    let tail: Promise<void> = Promise.resolve();
    const enqueue = (signal: AbortSignal, work: () => Promise<void>): Promise<void> => {
        const run = tail.then(async () => {
            signal.throwIfAborted();
            if (!options.current() || runtime.session.isReadOnly || runtime.session.isGestureActive) throw new DOMException('Keyboard transform is unavailable', 'AbortError');
            await work();
        });
        tail = run.catch(() => {}); return run;
    };
    const current = () => options.current() && !runtime.session.isReadOnly && !runtime.session.isGestureActive;
    const defaultSignal = () => new AbortController().signal;
    return {
        nudge(ids: readonly NodeId[], delta: Vec2, signal = defaultSignal()): Promise<void> {
            const selected = [...ids], movement = { ...delta };
            if (![movement.x, movement.y].every(Number.isFinite)) return Promise.reject(new RangeError('Invalid nudge'));
            return enqueue(signal, async () => {
                if (!selected.length || (!movement.x && !movement.y)) return;
                const plan = await createBoardTranslationPlan({ runtime, ids: selected, down: { x: 0, y: 0 },
                    zoom: () => 1, alwaysSnap: () => false, current, signal, cooperate: options.cooperate });
                try { const preview = await plan.preview(movement, false, false, signal); plan.commit(preview); }
                finally { plan.cancel(); }
            });
        },
        rotate(ids: readonly NodeId[], clockwise: boolean, fine = false, signal = defaultSignal()): Promise<void> {
            const selected = [...ids];
            return enqueue(signal, async () => {
                const session = runtime.session, doc = session.doc, revision = doc.rev, owner = session.owner, selection = runtime.selection.getSnapshot();
                const stable = () => current() && session.doc === doc && doc.rev === revision && session.owner === owner
                    && runtime.selection.getSnapshot() === selection;
                const roots = await selectedRootsAsync(doc, selected, { signal, current: stable, cooperate: options.cooperate }); if (!roots.length) return;
                const scope = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { signal, current: stable, cooperate: options.cooperate });
                let centre: Vec2;
                try {
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                    for (const root of roots) { const b = scope.logicalBounds(root.id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
                        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
                    centre = { x: x0 / 2 + x1 / 2, y: y0 / 2 + y1 / 2 };
                    if (![centre.x, centre.y].every(Number.isFinite)) throw new RangeError('Invalid rotation centre');
                } finally { scope.release(); }
                const radians = (clockwise ? 1 : -1) * Math.PI / (fine ? 192 : 12);
                const adjacent = nextUp(centre.x), down = { x: Number.isFinite(adjacent) ? adjacent : nextDown(centre.x), y: centre.y };
                const plan = await createBoardRotationPlan({ runtime, ids: selected, centre, down, orientation: 0,
                    current: stable, signal, cooperate: options.cooperate });
                try { const preview = await plan.previewAngle(radians, signal); plan.commit(preview); }
                finally { plan.cancel(); }
            });
        },
        scale(ids: readonly NodeId[], enlarge: boolean, signal = defaultSignal()): Promise<void> {
            const selected = [...ids];
            return enqueue(signal, async () => {
                if (!selected.length) return;
                const plan = await createBoardLeafResizePlan({ runtime, ids: selected, down: { x: 0, y: 0 }, handle: { x: 1, y: 1 },
                    scope: 'multi', current, signal, cooperate: options.cooperate });
                try {
                    const factor = enlarge ? 1.1 : 1 / 1.1, box = plan.startBox;
                    const x = box.width * (factor - 1) / 2, y = box.height * (factor - 1) / 2;
                    const c = Math.cos(box.rotation), s = Math.sin(box.rotation);
                    const preview = await plan.preview({ x: c * x - s * y, y: s * x + c * y }, { alt: true, shift: true }, signal);
                    plan.commit(preview);
                } finally { plan.cancel(); }
            });
        },
    };
}
