import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from '../input/tool';
import type { TransformDriver, TransformGestureServices } from './transform.types';

// The preview never changes the document; only a completed, still-current
// pointer-up applies its fully preflighted transaction.
export class TransformGesture implements GestureOwner {
    readonly kind = 'node-edit' as const;
    readonly pointerIds: ReadonlySet<number>;
    private readonly controller = new AbortController();
    private readonly release: () => void;
    private unregister: (() => void) | null = null;
    private sample: RealSample;
    private modifiers: Modifiers;
    private ended = false;
    private cancelled = false;
    private released = false;
    constructor(down: RealSample, modifiers: Modifiers, private readonly driver: TransformDriver,
        private readonly services: TransformGestureServices) {
        this.pointerIds = new Set([down.pointerId]); this.sample = down; this.modifiers = modifiers;
        this.release = services.hold();
    }
    private cleanup(): void {
        if (this.released) return;
        this.released = true;
        try { this.services.clearPreview(); }
        finally { this.unregister?.(); this.unregister = null; this.release(); }
    }
    update(samples: readonly RealSample[], modifiers: Modifiers): void {
        if (this.ended || this.cancelled) return;
        if (!this.services.isCurrent()) { this.cancel('invalidated'); return; }
        this.modifiers = modifiers;
        for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.sample = sample;
        try { this.services.showPreview(this.driver.preview(this.sample, modifiers)); }
        catch (error) { this.cancel('invalidated'); this.services.error(error); }
    }
    finish(reason: FinishReason): void {
        if (this.ended || this.cancelled) return;
        if (reason !== 'up' || !this.services.isCurrent()) { this.cancel('invalidated'); return; }
        this.ended = true;
        try {
            this.unregister = this.services.registerPending(() => this.cancel('invalidated'));
            const result = this.driver.finish(this.sample, this.modifiers, this.controller.signal);
            void Promise.resolve(result).then(transaction => {
                if (!this.cancelled && this.services.isCurrent() && !this.controller.signal.aborted && transaction.ops.length) this.services.apply(transaction);
            }).catch(error => { if (!this.cancelled) this.services.error(error); }).finally(() => this.cleanup());
        } catch (error) { this.cancel('invalidated'); this.services.error(error); }
    }
    cancel(_reason: CancelReason): void {
        if (this.cancelled || this.released) return;
        this.cancelled = true; this.ended = true; this.controller.abort();
        try { this.driver.cancel(); } finally { this.cleanup(); }
    }
}
