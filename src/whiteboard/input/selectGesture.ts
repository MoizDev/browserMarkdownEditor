import type { Vec2 } from '../geom/path';
import type { NodeId } from '../model/ids';
import type { SelectRegion, SelectToolContext } from '../tools/select';
import { SweepQueue, type SweepQueueServices } from './sweepQueue';
import { sampleSurface, type CancelReason, type FinishReason, type GestureOwner, type Modifiers, type RealSample, type Tool } from './tool';

export interface BoardSelectGestureContext extends SelectToolContext {
    readonly sampleToSurface: (sample: RealSample) => Vec2;
    beginHandle(sample: RealSample, modifiers: Modifiers): GestureOwner | null;
}

/** A selection contact owns its hit preflight, optional exact sweep and final
 * transaction handoff. Real points stay in their presented coordinate mapping. */
class BoardSelectGesture implements GestureOwner {
    readonly kind = 'marquee' as const;
    readonly pointerIds: ReadonlySet<number>;
    private readonly controller = new AbortController();
    private readonly release: () => void;
    private unregister: (() => void) | undefined;
    private readonly downSurface: Vec2;
    private readonly initial: readonly NodeId[];
    private readonly startKeys: Modifiers;
    private selectionFence: ReturnType<SelectToolContext['selection']['getSnapshot']>;
    private last: RealSample;
    private keys: Modifiers;
    private hit: NodeId | null | undefined;
    private dragging = false;
    private ended = false;
    private finishing = false;
    private cleaned = false;
    private transform: GestureOwner | null = null;
    private sweep: SweepQueue | null = null;
    private sweepLast: Vec2;
    private sweepPreview: ReadonlySet<NodeId> = new Set();
    private readonly points: Vec2[];

    constructor(private readonly down: RealSample, keys: Modifiers, private readonly context: BoardSelectGestureContext) {
        this.pointerIds = new Set([down.pointerId]); this.last = down; this.keys = keys; this.startKeys = keys;
        this.downSurface = sampleSurface(down, context.sampleToSurface);
        this.selectionFence = context.selection.getSnapshot(); this.initial = this.selectionFence.selected;
        this.sweepLast = { x: down.x, y: down.y }; this.points = [this.sweepLast];
        this.release = context.hold();
        try {
            this.unregister = context.registerPending(() => this.cancel('invalidated'));
            if (keys.alt) {
                const services: SweepQueueServices = { ...context.scribble,
                    preview: ids => {
                        this.sweepPreview = ids;
                        if (this.hit === null && this.dragging && this.valid()) context.scribble.preview(ids);
                    } };
                this.sweep = new SweepQueue(services);
                this.sweep.add(this.sweepLast, this.sweepLast, false);
            }
            void context.hit(down, this.controller.signal).then(id => {
                if (!this.valid()) { this.cancel('invalidated'); return; }
                this.hit = id;
                if (id !== null && this.sweep) { this.sweep.cancel(); this.sweep = null; this.points.length = 1; }
                if (this.dragging) this.activateDrag();
                if (this.ended) this.complete();
            }).catch(error => this.fail(error));
        } catch (error) { this.cancel('invalidated'); throw error; }
    }

    private valid(): boolean {
        return !this.cleaned && !this.controller.signal.aborted && this.context.isCurrent()
            && this.context.selection.getSnapshot() === this.selectionFence;
    }
    private cleanup(): void {
        if (this.cleaned) return;
        this.cleaned = true; this.controller.abort();
        try { this.context.preview(null); }
        finally {
            try { if (this.sweep) this.context.scribble.preview(new Set()); }
            finally { try { this.unregister?.(); } finally { this.unregister = undefined; this.release(); } }
        }
    }
    private fail(error: unknown): void {
        if (this.cleaned || this.controller.signal.aborted) return;
        try { this.cancel('invalidated'); }
        finally { if (!(error instanceof DOMException && error.name === 'AbortError')) this.context.onError(error); }
    }
    private region(): SelectRegion {
        return this.startKeys.alt && this.hit === null
            ? { kind: 'scribble', points: this.points }
            : { kind: 'marquee', start: { x: this.down.x, y: this.down.y }, end: { x: this.last.x, y: this.last.y }, containment: this.keys.control };
    }
    private activateDrag(): void {
        if (!this.valid() || this.hit === undefined || this.transform) return;
        if (this.hit !== null) {
            if (!this.context.selection.getSnapshot().selected.includes(this.hit)) {
                // Default: Shift-drag adds the hit before moving; Shift-click still toggles on release.
                this.context.selection.replace(this.startKeys.shift ? [...this.initial, this.hit] : [this.hit]);
                this.selectionFence = this.context.selection.getSnapshot();
            }
            this.transform = this.context.beginTransform(this.down, this.hit, this.startKeys);
            this.transform.update([this.last], this.keys);
        } else {
            if (this.sweep) this.context.scribble.preview(this.sweepPreview);
            this.context.preview(this.region());
        }
    }
    update(samples: readonly RealSample[], keys: Modifiers): void {
        if (this.ended || this.cleaned) return;
        if (!this.valid()) { this.cancel('invalidated'); return; }
        try {
            this.keys = keys;
            for (const sample of samples) {
                if (!this.pointerIds.has(sample.pointerId)) continue;
                this.last = sample;
                if (this.sweep) {
                    const next = { x: sample.x, y: sample.y };
                    this.sweep.add(this.sweepLast, next, false); this.sweepLast = next; this.points.push(next);
                }
            }
            if (!this.dragging) {
                const surface = sampleSurface(this.last, this.context.sampleToSurface);
                this.dragging = Math.hypot(surface.x - this.downSurface.x, surface.y - this.downSurface.y) >= this.context.dragThresholdCss;
            }
            if (this.transform) this.transform.update(samples, keys);
            else if (this.dragging) this.activateDrag();
        } catch (error) { this.fail(error); }
    }
    finish(reason: FinishReason): void {
        if (this.ended || this.cleaned) return;
        if (reason !== 'up' || !this.valid()) { this.cancel('invalidated'); return; }
        this.ended = true;
        if (this.hit !== undefined) this.complete();
    }
    private complete(): void {
        if (this.finishing || this.cleaned) return;
        if (!this.valid()) { this.cancel('invalidated'); return; }
        this.finishing = true;
        try {
            this.context.preview(null);
            if (this.transform) {
                const transform = this.transform; this.transform = null;
                try { transform.finish('up'); } finally { this.cleanup(); }
                return;
            }
            if (!this.dragging) {
                this.sweep?.cancel(); this.sweep = null;
                if (this.hit === null) { if (!this.keys.shift) this.context.selection.clear(); }
                else if (this.hit !== undefined) {
                    if (this.keys.shift) this.context.selection.toggle(this.hit);
                    else this.context.selection.replace([this.hit]);
                }
                this.cleanup(); return;
            }
            const region = this.region();
            const result = this.sweep ? this.sweep.finish().then(ids => [...ids]) : this.context.region(region, this.controller.signal);
            void result.then(ids => {
                if (!this.valid()) { this.cancel('invalidated'); return; }
                this.context.selection.replace(this.keys.shift ? [...this.initial, ...ids] : ids);
                this.cleanup();
            }).catch(error => this.fail(error));
        } catch (error) { this.fail(error); }
    }
    cancel(reason: CancelReason): void {
        if (this.cleaned) return;
        try { this.sweep?.cancel(); }
        finally { try { this.transform?.cancel(reason); } finally { this.transform = null; this.cleanup(); } }
    }
}

export const boardSelectTool: Tool<BoardSelectGestureContext> = {
    id: 'select',
    begin(sample, modifiers, context) {
        return context.beginHandle(sample, modifiers) ?? new BoardSelectGesture(sample, modifiers, context);
    },
};
