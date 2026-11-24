import type { Op } from '../change/ops';
import { createBoardLeafResizePlan, type BoardLeafResizePlan, type BoardLeafResizePlanOptions, type BoardLeafResizePreview } from '../geom/runtimeLeafPlan';
import { createBoardRotationPlan, type BoardRotationOptions, type BoardRotationPlan, type BoardRotationPreview } from '../geom/runtimeTransforms';
import { createBoardTranslationPlan, type BoardTranslationOptions, type BoardTranslationPreview } from '../geom/runtimeTranslation';
import { snapBoardBounds, type BoardSnapGuide } from '../geom/runtimeSnap';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';
import { PointerPace } from './pointerPace';
import { prepareFrameDrop, type FrameDropPlan } from './frameDrop';
import { createDuplicateDragPlan, type DuplicateDragPreview } from './duplicateDrag';
import { prepareNotebookTransform, prepareNotebookTranslation, type NotebookTransform, type NotebookTranslation } from './notebookTranslation';
import type { BoardDoc } from '../model/doc';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';

export interface AsyncTransformGestureHost {
    hold(): () => void;
    registerPending(cancel: () => void): () => void;
    current(): boolean;
    /** `live`: a pointer move (the preview moves its picture); absent for the commit's own preview. */
    show(ops: readonly Op[], live?: boolean): void;
    waitUntilReady(signal: AbortSignal): Promise<void>;
    armCommit(): void;
    finishCommit(): void;
    cancelCommit(): void;
    guides?(guides: readonly BoardSnapGuide[]): void;
    clear(): void;
    error(error: unknown): void;
}
interface Plan<Preview extends { readonly ops: readonly Op[] }> {
    preview(sample: RealSample, modifiers: Modifiers, signal: AbortSignal, commit: boolean): Promise<Preview>;
    commit(preview: Preview): void;
    display?(preview: Preview): void;
    cancel(): void;
}

/** The latest pointer owns publication; a release waits for its exact final plan. */
class AsyncTransformGesture<Preview extends { readonly ops: readonly Op[] }> implements GestureOwner {
    readonly kind = 'node-edit' as const;
    readonly pointerIds: ReadonlySet<number>;
    private readonly controller = new AbortController();
    private readonly release: () => void;
    private unregister: (() => void) | undefined;
    private request: AbortController | undefined;
    private plan: Plan<Preview> | undefined;
    private sample: RealSample;
    private modifiers: Modifiers;
    private generation = 0;
    private ended = false;
    private cleaned = false;
    private readonly ready: Promise<Plan<Preview>>;
    constructor(sample: RealSample, modifiers: Modifiers, create: (signal: AbortSignal) => Promise<Plan<Preview>>,
        private readonly host: AsyncTransformGestureHost, private readonly pace?: PointerPace) {
        this.pointerIds = new Set([sample.pointerId]); this.sample = sample; this.modifiers = modifiers;
        this.release = host.hold();
        try { this.unregister = host.registerPending(() => this.cancel('invalidated')); }
        catch (error) { this.release(); throw error; }
        this.ready = create(this.controller.signal).then(plan => {
            if (this.controller.signal.aborted || !this.host.current()) { plan.cancel(); throw new DOMException('Transform view ended', 'AbortError'); }
            this.plan = plan; return plan;
        });
        void this.render(false);
    }
    private cleanup(): void {
        if (this.cleaned) return;
        this.cleaned = true;
        try { this.host.clear(); } finally { try { this.unregister?.(); } finally { this.release(); } }
    }
    private async render(commit: boolean): Promise<void> {
        const generation = ++this.generation;
        this.request?.abort(); const request = new AbortController(); this.request = request;
        const sample = this.sample, modifiers = this.modifiers;
        try {
            const plan = await this.ready;
            if (request.signal.aborted || this.controller.signal.aborted || generation !== this.generation) return;
            if (!this.host.current()) { this.cancel('invalidated'); return; }
            const value = await plan.preview(sample, modifiers, request.signal, commit);
            if (request.signal.aborted || this.controller.signal.aborted || generation !== this.generation) return;
            if (!this.host.current()) { this.cancel('invalidated'); return; }
            if (commit) {
                if (value.ops.length) {
                    this.host.show(value.ops);
                    await this.host.waitUntilReady(request.signal);
                    if (request.signal.aborted || this.controller.signal.aborted || generation !== this.generation) return;
                    if (!this.host.current()) { this.cancel('invalidated'); return; }
                    this.host.armCommit();
                    try { plan.commit(value); this.host.finishCommit(); }
                    catch (error) { this.host.cancelCommit(); throw error; }
                } else plan.commit(value);
                this.cleanup();
            } else { plan.display?.(value); this.host.show(value.ops, true); }
        } catch (error) {
            if (!request.signal.aborted && !this.controller.signal.aborted && generation === this.generation) {
                try { this.host.error(error); } finally { this.cancel('invalidated'); }
            }
        }
    }
    update(samples: readonly RealSample[], modifiers: Modifiers): void {
        if (this.ended || this.controller.signal.aborted) return;
        if (!this.host.current()) { this.cancel('invalidated'); return; }
        this.modifiers = modifiers;
        const following = samples.filter(sample => this.pointerIds.has(sample.pointerId));
        this.pace?.observe(following);
        for (const sample of following) this.sample = sample;
        void this.render(false);
    }
    finish(reason: FinishReason): void {
        if (this.ended || this.controller.signal.aborted) return;
        if (reason !== 'up' || !this.host.current()) { this.cancel('invalidated'); return; }
        this.ended = true; void this.render(true);
    }
    cancel(_reason: CancelReason): void {
        if (this.cleaned) return;
        this.ended = true; this.generation++; this.controller.abort(); this.request?.abort();
        try { this.plan?.cancel(); } finally { this.cleanup(); }
    }
}

export function translationHandleGesture(sample: RealSample, modifiers: Modifiers, options: Omit<BoardTranslationOptions, 'down' | 'signal'>,
    host: AsyncTransformGestureHost): GestureOwner {
    const pace = new PointerPace(sample);
    if (modifiers.alt) return new AsyncTransformGesture<DuplicateDragPreview>(sample, modifiers, async signal => {
        const plan = await createDuplicateDragPlan({ ...options, down: sample, signal });
        return { preview: (point, keys, request, commit) => plan.preview(point, keys.shift, keys.accel, request, commit, pace.speed()),
            display: value => host.guides?.(value.guides), commit: value => plan.commit(value), cancel: () => plan.cancel() };
    }, host, pace);
    type Preview = { readonly ops: readonly Op[]; readonly base: BoardTranslationPreview;
        readonly drop: FrameDropPlan | null; readonly notebook: NotebookTranslation | null };
    return new AsyncTransformGesture<Preview>(sample, modifiers, async signal => {
        const plan = await createBoardTranslationPlan({ ...options, down: sample, signal });
        let drop: FrameDropPlan | null = null, notebook: NotebookTranslation | null = null;
        const clear = () => { try { drop?.release(); } finally { drop = null; notebook?.release(); notebook = null; } };
        return {
            async preview(point, keys, request, commit) {
                clear(); const base = await plan.preview(point, keys.shift, keys.accel, request, pace.speed());
                const active = () => !signal.aborted && options.current() && host.current();
                if (commit && base.ops.length) {
                    const grown = await prepareNotebookTranslation({ runtime: options.runtime, ids: options.ids, preview: base,
                        signal: request, current: active, cooperate: options.cooperate });
                    if (request.aborted || signal.aborted) { grown?.release(); throw new DOMException('Notebook move cancelled', 'AbortError'); }
                    notebook = grown;
                }
                // Frame membership is planned for the commit only: a live parent change left the original picture drawn at its
                // start during the drag (measured; ESCALATION in gap.md), so the in-progress preview keeps the plain move.
                if (commit && base.ops.length) {
                    const prepared = await prepareFrameDrop({ runtime: options.runtime, ids: options.ids, preview: notebook?.preview ?? base,
                        signal: request, current: active, cooperate: options.cooperate });
                    if (request.aborted || signal.aborted) { prepared?.release(); throw new DOMException('Frame drop cancelled', 'AbortError'); }
                    drop = prepared;
                }
                const ops = notebook?.ops ?? base.ops;
                return { base, drop, notebook, ops: drop ? [...ops, ...drop.ops] : ops };
            },
            display: value => host.guides?.(value.base.guides),
            commit(value) {
                if (!value.drop && !value.notebook) { plan.commit(value.base); return; }
                try {
                    if (value.drop !== drop || value.notebook !== notebook || signal.aborted || !options.current() || !host.current()) throw new DOMException('Translation became stale', 'AbortError');
                    const applied = options.runtime.session.apply({ origin: 'tool', label: 'Move selection', ops: value.ops }); applied.release();
                } finally { clear(); plan.cancel(); }
            },
            cancel() { clear(); plan.cancel(); },
        };
    }, host, pace);
}

type GrowthValue<T extends { readonly doc: BoardDoc; readonly ops: readonly Op[] }> = {
    readonly base: T; readonly notebook: NotebookTransform<T> | null; readonly ops: readonly Op[];
};
function withNotebookGrowth<T extends { readonly doc: BoardDoc; readonly ops: readonly Op[] }>(plan: Plan<T>, options: {
    readonly runtime: BoardRuntime; readonly ids: readonly NodeId[]; readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}, signal: AbortSignal, host: AsyncTransformGestureHost, label: string): Plan<GrowthValue<T>> {
    let notebook: NotebookTransform<T> | null = null;
    const clear = () => { notebook?.release(); notebook = null; };
    return {
        async preview(point, keys, request, commit) {
            clear(); const base = await plan.preview(point, keys, request, commit);
            if (commit && base.ops.length) {
                const prepared = await prepareNotebookTransform({ runtime: options.runtime, ids: options.ids, preview: base,
                    signal: request, current: () => !signal.aborted && options.current() && host.current(), cooperate: options.cooperate });
                if (request.aborted || signal.aborted) { prepared?.release(); throw new DOMException('Notebook transform cancelled', 'AbortError'); }
                notebook = prepared;
            }
            return { base, notebook, ops: notebook?.ops ?? base.ops };
        },
        display(value) { plan.display?.(value.base); },
        commit(value) {
            if (!value.notebook) { plan.commit(value.base); return; }
            try {
                if (value.notebook !== notebook || signal.aborted || !options.current() || !host.current()) throw new DOMException('Notebook transform became stale', 'AbortError');
                const applied = options.runtime.session.apply({ origin: 'tool', label, ops: value.ops }); applied.release();
            } finally { clear(); plan.cancel(); }
        },
        cancel() { clear(); plan.cancel(); },
    };
}

export function rotationHandleGesture(sample: RealSample, modifiers: Modifiers, options: Omit<BoardRotationOptions, 'down' | 'signal'>,
    host: AsyncTransformGestureHost): GestureOwner {
    const coarse = sample.source === 'touch';
    return new AsyncTransformGesture<GrowthValue<BoardRotationPreview>>(sample, modifiers, async signal => {
        const plan: BoardRotationPlan = await createBoardRotationPlan({ ...options, down: sample, signal });
        return withNotebookGrowth({ preview: (point, keys, request, commit) => plan.preview(point, keys.shift, request, commit ? { coarse } : undefined),
            commit: value => plan.commit(value), cancel: () => plan.cancel() }, options, signal, host, 'Rotate selection');
    }, host);
}
export interface ResizeSnapOptions {
    readonly zoom: () => number;
    readonly alwaysSnap: () => boolean;
}
export function leafResizeHandleGesture(sample: RealSample, modifiers: Modifiers, options: Omit<BoardLeafResizePlanOptions, 'down' | 'signal'>,
    host: AsyncTransformGestureHost, snap?: ResizeSnapOptions): GestureOwner {
    return new AsyncTransformGesture<GrowthValue<BoardLeafResizePreview>>(sample, modifiers, async signal => {
        const plan: BoardLeafResizePlan = await createBoardLeafResizePlan({ ...options, down: sample, signal });
        const { runtime, ids } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
        const selection = runtime.selection.getSnapshot(), font = runtime.render.text.fonts.epoch;
        const guides = new WeakMap<BoardLeafResizePreview, readonly BoardSnapGuide[]>();
        let signX: -1 | 1 = 1, signY: -1 | 1 = 1;
        const remember = (value: BoardLeafResizePreview) => {
            if (value.frame.scaleX !== 0) signX = value.frame.scaleX < 0 ? -1 : 1;
            if (value.frame.scaleY !== 0) signY = value.frame.scaleY < 0 ? -1 : 1;
        };
        return withNotebookGrowth<BoardLeafResizePreview>({
            async preview(point, keys, request) {
                let result = await plan.preview(point, { shift: keys.shift, alt: keys.alt }, request, signX, signY);
                remember(result);
                const active = () => !signal.aborted && !request.aborted && options.current() && session.owner === owner
                    && session.doc === doc && doc.rev === revision && runtime.selection.getSnapshot() === selection
                    && runtime.render.text.fonts.epoch === font;
                // Object snapping only where the rotation is a right angle (a rotated box's features are not its edges), and the
                // grid whenever Cmd/Ctrl is not held. Neither is gated by velocity.
                const quarter = plan.startBox.rotation / (Math.PI / 2), rightAngle = Math.abs(quarter - Math.round(quarter)) < 1e-9;
                const objects = !!snap && snap.alwaysSnap() !== keys.accel && rightAngle, grid = !!snap && !keys.accel;
                if (!snap || (!objects && !grid) || Math.hypot(point.x - sample.x, point.y - sample.y) * snap.zoom() < 1) {
                    guides.set(result, []); return result;
                }
                const scope = await acquireBoardGeometryScope(runtime, ids, { doc: result.doc, signal: request, current: active, cooperate: options.cooperate });
                let bounds: { x: number; y: number; width: number; height: number };
                try {
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, visited = 0;
                    for (const id of ids) {
                        const b = scope.logicalBounds(id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
                        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
                        if (++visited % 128 === 0) {
                            await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
                            if (!active()) throw new DOMException('Resize snapping became stale', 'AbortError');
                        }
                    }
                    bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
                } finally { scope.release(); }
                if (!active()) throw new DOMException('Resize snapping became stale', 'AbortError');
                const target = await snapBoardBounds({ runtime, bounds, selected: ids, zoom: snap.zoom(), current: active, signal: request, cooperate: options.cooperate, objects, grid });
                if (!active()) throw new DOMException('Resize snapping became stale', 'AbortError');
                const angle = plan.startBox.rotation, c = Math.cos(angle), s = Math.sin(angle), factor = keys.alt ? 2 : 1;
                const localX = options.handle.x ? (c * target.delta.x + s * target.delta.y) / factor : 0;
                const localY = options.handle.y ? (-s * target.delta.x + c * target.delta.y) / factor : 0;
                const dx = c * localX - s * localY, dy = s * localX + c * localY;
                if (dx || dy) {
                    result = await plan.preview({ x: point.x + dx, y: point.y + dy }, { shift: keys.shift, alt: keys.alt }, request, signX, signY);
                    remember(result);
                }
                // A side handle cannot claim a guide that its constrained movement did not reach.
                const actualX = (c * localX - s * localY) * factor, actualY = (s * localX + c * localY) * factor;
                guides.set(result, target.guides.filter(guide => Math.abs((guide.axis === 'x' ? actualX - target.delta.x : actualY - target.delta.y) * snap.zoom()) <= 0.5));
                return result;
            },
            display: value => host.guides?.(guides.get(value) ?? []),
            commit: value => plan.commit(value), cancel: () => plan.cancel(),
        }, options, signal, host, 'Resize selection');
    }, host);
}
