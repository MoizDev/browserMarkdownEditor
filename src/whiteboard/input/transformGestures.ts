import type { Op } from '../change/ops';
import { createBoardLeafResizePlan, type BoardLeafResizePlan, type BoardLeafResizePlanOptions, type BoardLeafResizePreview } from '../geom/runtimeLeafPlan';
import { createBoardRotationPlan, type BoardRotationOptions, type BoardRotationPlan, type BoardRotationPreview } from '../geom/runtimeTransforms';
import { createBoardTranslationPlan, type BoardTranslationOptions, type BoardTranslationPreview } from '../geom/runtimeTranslation';
import type { BoardSnapGuide } from '../geom/runtimeSnap';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export interface AsyncTransformGestureHost {
    hold(): () => void;
    registerPending(cancel: () => void): () => void;
    current(): boolean;
    show(ops: readonly Op[]): void;
    guides?(guides: readonly BoardSnapGuide[]): void;
    clear(): void;
    error(error: unknown): void;
}
interface Plan<Preview extends { readonly ops: readonly Op[] }> {
    preview(sample: RealSample, modifiers: Modifiers, signal: AbortSignal): Promise<Preview>;
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
        private readonly host: AsyncTransformGestureHost) {
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
            const value = await plan.preview(sample, modifiers, request.signal);
            if (request.signal.aborted || this.controller.signal.aborted || generation !== this.generation) return;
            if (!this.host.current()) { this.cancel('invalidated'); return; }
            if (commit) { plan.commit(value); this.cleanup(); }
            else { plan.display?.(value); this.host.show(value.ops); }
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
        for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.sample = sample;
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
    return new AsyncTransformGesture<BoardTranslationPreview>(sample, modifiers, async signal => {
        const plan = await createBoardTranslationPlan({ ...options, down: sample, signal });
        return { preview: (point, keys, request) => plan.preview(point, keys.shift, keys.accel, request),
            display: value => host.guides?.(value.guides), commit: value => plan.commit(value), cancel: () => plan.cancel() };
    }, host);
}

export function rotationHandleGesture(sample: RealSample, modifiers: Modifiers, options: Omit<BoardRotationOptions, 'down' | 'signal'>,
    host: AsyncTransformGestureHost): GestureOwner {
    return new AsyncTransformGesture<BoardRotationPreview>(sample, modifiers, async signal => {
        const plan: BoardRotationPlan = await createBoardRotationPlan({ ...options, down: sample, signal });
        return { preview: (point, keys, request) => plan.preview(point, keys.shift, request), commit: value => plan.commit(value), cancel: () => plan.cancel() };
    }, host);
}
export function leafResizeHandleGesture(sample: RealSample, modifiers: Modifiers, options: Omit<BoardLeafResizePlanOptions, 'down' | 'signal'>,
    host: AsyncTransformGestureHost): GestureOwner {
    return new AsyncTransformGesture<BoardLeafResizePreview>(sample, modifiers, async signal => {
        const plan: BoardLeafResizePlan = await createBoardLeafResizePlan({ ...options, down: sample, signal });
        let signX: -1 | 1 = 1, signY: -1 | 1 = 1;
        return {
            async preview(point, keys, request) {
                const result = await plan.preview(point, { shift: keys.shift, alt: keys.alt }, request, signX, signY);
                if (result.frame.scaleX !== 0) signX = result.frame.scaleX < 0 ? -1 : 1;
                if (result.frame.scaleY !== 0) signY = result.frame.scaleY < 0 ? -1 : 1;
                return result;
            },
            commit: value => plan.commit(value), cancel: () => plan.cancel(),
        };
    }, host);
}
