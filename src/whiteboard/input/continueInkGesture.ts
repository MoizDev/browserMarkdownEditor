import { LocalCurveBuilder, type CurvePublication } from '../ink/curve';
import type { BoardSession } from '../session/BoardSession';
import type { InkContinuation } from './continueInk';
import { WetInkHandover } from './liveInk';
import { snapStraightEnd } from './straightInk';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export interface InkContinuationGestureOptions {
    readonly session: BoardSession;
    readonly handover: WetInkHandover;
    readonly invalidate: () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly error: (error: unknown) => void;
}

/** The transient straight segment uses the same wet packet and dry acknowledgement
 * as ordinary ink. The original stroke stays immutable until one guarded apply. */
export class InkContinuationGesture implements GestureOwner {
    readonly kind = 'node-edit' as const;
    readonly pointerIds: ReadonlySet<number>;
    private readonly controller = new AbortController();
    private readonly release: () => void;
    private unregister: (() => void) | undefined;
    private endpoint: RealSample;
    private snapshot: CurvePublication | null = null;
    private dirty = true;
    private snapAngle = false;
    private ended = false;
    private running = false;
    private cleaned = false;

    constructor(first: RealSample, private readonly plan: InkContinuation, private readonly options: InkContinuationGestureOptions) {
        this.pointerIds = new Set([first.pointerId]); this.endpoint = first;
        this.release = options.session.beginGesture();
        try { this.unregister = options.registerPending(() => this.cancel('invalidated')); }
        catch (error) { this.release(); throw error; }
        try { this.options.invalidate(); }
        catch (error) { this.cancel('invalidated'); throw error; }
    }
    private valid(): boolean { return !this.cleaned && !this.controller.signal.aborted && this.plan.current(); }
    private cleanup(): void {
        if (this.cleaned) return;
        this.cleaned = true;
        try { this.unregister?.(); } finally { this.unregister = undefined; this.release(); }
    }
    update(samples: readonly RealSample[], modifiers: Modifiers): void {
        if (this.ended || this.cleaned) return;
        if (!this.valid()) { this.cancel('invalidated'); return; }
        this.snapAngle = modifiers.shift && !modifiers.accel && !modifiers.control;
        for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.endpoint = sample;
        if (samples.length) { this.dirty = true; this.options.invalidate(); }
    }
    /** Called from the shared input frame, never by an independent animation loop. */
    publish(): void {
        if (this.ended || !this.dirty || !this.valid()) return;
        const first = this.plan.first, end = snapStraightEnd(first, this.plan.toLocal(this.endpoint), this.snapAngle);
        if (![first.x, first.y, end.x, end.y].every(Number.isFinite)) throw new RangeError('Invalid continuation preview');
        const curve = new LocalCurveBuilder({ pressure: false, declaredMaxScale: this.plan.declaredMaxScale, precision: 'float64' },
            this.plan.captureDeviceScale, this.plan.presentation.fairTol);
        curve.append(first.x, first.y, undefined, 'freehand');
        if (end.x !== first.x || end.y !== first.y) curve.append(end.x, end.y, undefined, 'straight');
        this.snapshot = curve.publish(); this.dirty = false;
        this.options.handover.publish({ identity: this.plan.identity, presentation: this.plan.presentation, curve: this.snapshot, dry: null });
    }
    finish(reason: FinishReason): void {
        if (this.ended || this.cleaned) return;
        if (reason !== 'up' || !this.valid()) { this.cancel('invalidated'); return; }
        try { this.publish(); }
        catch (error) { try { this.cancel('invalidated'); } finally { this.options.error(error); } return; }
        this.ended = true; this.running = true;
        void this.plan.commit(this.endpoint, this.controller.signal, this.snapAngle).then(dry => {
            if (this.controller.signal.aborted || this.cleaned || !dry || !this.snapshot) {
                dry?.release?.(); this.options.handover.clear(this.plan.identity); return;
            }
            try {
                this.options.handover.publish({ identity: this.plan.identity, presentation: this.plan.presentation, curve: this.snapshot, dry });
            } catch (error) { dry.release?.(); throw error; }
            this.options.invalidate();
        }).catch(error => {
            this.options.handover.clear(this.plan.identity);
            if (!this.controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) this.options.error(error);
        }).finally(() => { this.running = false; this.cleanup(); });
    }
    cancel(_reason: CancelReason): void {
        if (this.cleaned) return;
        this.ended = true; this.controller.abort();
        try { this.options.handover.clear(this.plan.identity); this.options.invalidate(); }
        finally { if (!this.running) this.cleanup(); }
    }
    discard(): void { this.cancel('invalidated'); }
}
