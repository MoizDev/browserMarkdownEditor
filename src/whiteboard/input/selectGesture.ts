import type { Vec2 } from '../geom/path';
import type { NodeId } from '../model/ids';
import type { SelectRegion, SelectToolContext } from '../tools/select';
import { SweepQueue, type SweepQueueServices } from './sweepQueue';
import { sampleSurface, type CancelReason, type FinishReason, type GestureOwner, type Modifiers, type RealSample, type Tool } from './tool';
import { isCancellation } from '../../platform/workers/envelope';

export interface BoardSelectGestureContext extends SelectToolContext {
    readonly sampleToSurface: (sample: RealSample) => Vec2;
    beginHandle(sample: RealSample, modifiers: Modifiers): GestureOwner | null;
    insideSelection(sample: RealSample): boolean;
    prewarm?(): void;
    readonly wrapMode?: () => boolean;
    selectionHandleAt?(sample: RealSample): boolean;
    leaveFocusAt?(point: Vec2): void;
    brushOverHandle?(sample: RealSample): boolean;
    editTextAt?(node: NodeId, point: Vec2, pointerId: number, clicks: number): void | Promise<void>;
    settle(): () => void;
    registerSettling(cancel: () => void, undoable: boolean): () => void;
    settled(): Promise<void>;
}
const REGION_ATTEMPTS = 32;

class BoardSelectGesture implements GestureOwner {
    readonly kind = 'marquee' as const;
    readonly pointerIds: ReadonlySet<number>;
    private readonly controller = new AbortController();
    private release: () => void;
    private unregister: (() => void) | undefined;
    private readonly downSurface: Vec2;
    private initial: readonly NodeId[] = [];
    private readonly startKeys: Modifiers;
    private selectionFence: ReturnType<SelectToolContext['selection']['getSnapshot']> | null = null;
    private last: RealSample;
    private keys: Modifiers;
    private hit: NodeId | null | undefined;
    private body = false;
    private dragging = false;
    private ended = false;
    private finishing = false;
    private cleaned = false;
    private transform: GestureOwner | null = null;
    private transformAlt = false;
    private sweep: SweepQueue | null = null;
    private sweepLast: Vec2;
    private sweepPreview: ReadonlySet<NodeId> = new Set();
    private readonly points: Vec2[];
    private shown: readonly NodeId[] | null = null;
    private liveBusy = false;
    private liveDirty = false;

    constructor(private readonly down: RealSample, keys: Modifiers, private readonly context: BoardSelectGestureContext, private readonly brushOnly = false) {
        this.pointerIds = new Set([down.pointerId]); this.last = down; this.keys = keys; this.startKeys = keys;
        this.downSurface = sampleSurface(down, context.sampleToSurface);
        this.sweepLast = { x: down.x, y: down.y }; this.points = [this.sweepLast];
        this.release = context.hold();
        try {
            this.unregister = context.registerPending(() => this.cancel('invalidated'));
            if (keys.alt) this.startSweep();
            void this.decide().catch(error => this.fail(error));
        } catch (error) { this.cancel('invalidated'); throw error; }
    }

    private startSweep(): void {
        const services: SweepQueueServices = { ...this.context.scribble,
            preview: ids => {
                this.sweepPreview = ids;
                if (this.hit === null && this.dragging && this.valid()) this.context.scribble.preview(ids);
                if (this.hit === null && this.dragging) this.showSelection([...ids]);
            } };
        this.sweep = new SweepQueue(services);
        this.sweep.add(this.sweepLast, this.sweepLast, false);
    }

    private async decide(): Promise<void> {
        await this.context.settled();
        if (!this.valid()) { this.cancel('invalidated'); return; }
        this.selectionFence = this.context.selection.getSnapshot(); this.initial = this.selectionFence.selected;
        const id = await this.context.hit(this.down, this.controller.signal);
        if (!this.valid()) { this.cancel('invalidated'); return; }
        this.hit = this.brushOnly ? null : id;
        this.body = !this.brushOnly && id === null && !this.startKeys.shift && !this.startKeys.alt && this.initial.length > 0
            && this.context.insideSelection(this.down) && !(this.startKeys.accel && this.context.selectionHandleAt?.(this.down));
        if (this.body || (id !== null && this.initial.includes(id))) this.context.prewarm?.();
        if (id !== null && this.sweep) { this.sweep.cancel(); this.sweep = null; this.points.length = 1; }
        if (this.dragging) this.activateDrag();
        if (this.ended) this.complete();
    }
    private valid(): boolean {
        return !this.cleaned && !this.controller.signal.aborted && this.context.isCurrent()
            && (this.transform !== null || this.selectionFence === null || this.context.selection.getSnapshot() === this.selectionFence);
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
        finally { if (!isCancellation(error)) this.context.onError(error); }
    }
    private region(): SelectRegion {
        return this.keys.alt && this.hit === null
            ? { kind: 'scribble', points: this.points }
            : { kind: 'marquee', start: { x: this.down.x, y: this.down.y }, end: { x: this.last.x, y: this.last.y }, containment: this.containment() };
    }
    private containment(): boolean {
        return (this.context.wrapMode?.() ?? false) !== this.keys.accel;
    }
    private activateDrag(): void {
        if (!this.valid() || this.hit === undefined || this.transform) return;
        if (this.body) this.beginMove(this.initial[0]);
        else if (this.hit !== null && !this.startKeys.accel) {
            if (!this.context.selection.getSnapshot().selected.includes(this.hit)) {
                this.context.selection.replace(this.startKeys.shift ? [...this.initial, this.hit] : [this.hit]);
                this.selectionFence = this.context.selection.getSnapshot();
            }
            this.beginMove(this.hit);
        } else {
            if (this.sweep) this.context.scribble.preview(this.sweepPreview);
            this.context.preview(this.region());
            this.refreshMarquee();
        }
    }
    private showSelection(ids: readonly NodeId[]): void {
        if (this.ended || this.cleaned || !this.valid() || !this.selectionFence) return;
        const next = [...new Set(this.keys.shift ? [...this.initial, ...ids] : ids)];
        const current = this.selectionFence.selected;
        if (current.length === next.length && next.every(id => current.includes(id))) return;
        this.context.selection.replace(next);
        this.selectionFence = this.context.selection.getSnapshot();
        this.shown = this.selectionFence.selected;
    }
    private refreshMarquee(): void {
        if (this.sweep || this.transform || this.ended || !this.dragging || this.hit === undefined) return;
        if (this.liveBusy) { this.liveDirty = true; return; }
        this.liveBusy = true; this.liveDirty = false;
        void this.context.region(this.region(), this.controller.signal).then(ids => {
            this.liveBusy = false;
            this.showSelection(ids);
            if (this.liveDirty) this.refreshMarquee();
        }).catch(error => { this.liveBusy = false; this.fail(error); });
    }
    private restoreShown(): void {
        const shown = this.shown;
        this.shown = null;
        if (!shown) return;
        const current = this.context.selection.getSnapshot().selected;
        if (current.length === shown.length && shown.every(id => current.includes(id))) this.context.selection.replace(this.initial);
    }
    private beginMove(hit: NodeId): void {
        this.transformAlt = this.keys.alt;
        this.transform = this.context.beginTransform(this.down, hit, { ...this.startKeys, alt: this.keys.alt });
        this.transform.update([this.last], this.keys);
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
            if (this.transform && keys.alt !== this.transformAlt) {
                const previous = this.transform; this.transform = null; previous.cancel('invalidated');
                if (this.dragging) this.activateDrag();
            }
            else if (this.transform) this.transform.update(samples, keys);
            else if (this.dragging) this.activateDrag();
            if (!this.transform && (this.hit === null || this.hit === undefined)) {
                if (keys.alt && !this.sweep) { this.startSweep(); this.points.length = 0; this.points.push(this.sweepLast); }
                else if (!keys.alt && this.sweep) { this.sweep.cancel(); this.sweep = null; this.context.scribble.preview(new Set()); }
            }
        } catch (error) { this.fail(error); }
    }
    finish(reason: FinishReason): void {
        if (this.ended || this.cleaned) return;
        if (reason !== 'up' || !this.valid()) { this.cancel('invalidated'); return; }
        this.ended = true;
        if (!this.settling()) return;
        if (this.hit !== undefined) this.complete();
    }
    private settling(): boolean {
        let settle: (() => void) | null = null;
        try {
            settle = this.context.settle();
            const unregister = this.context.registerSettling(() => this.cancel('invalidated'), false);
            this.unregister?.(); this.unregister = unregister;
        } catch (error) {
            settle?.(); this.cancel('invalidated');
            if (!isCancellation(error)) this.context.onError(error);
            return false;
        }
        const input = this.release;
        this.release = settle;
        input();
        return true;
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
                const additive = (this.keys.shift || this.keys.accel) && !this.keys.alt;
                if (this.hit === null) {
                    if (!additive) { this.context.selection.clear(); this.context.leaveFocusAt?.({ x: this.down.x, y: this.down.y }); }
                }
                else if (this.hit !== undefined) {
                    if (additive) this.context.selection.toggle(this.hit);
                    else {
                        const sole = this.hit !== null && !this.keys.alt && this.initial.length === 1 && this.initial[0] === this.hit;
                        this.context.selection.replace([this.hit]);
                        if (sole) void this.context.editTextAt?.(this.hit, { x: this.down.x, y: this.down.y }, this.down.pointerId, this.down.clicks ?? 1);
                    }
                }
                this.cleanup(); return;
            }
            const region = this.region();
            const query = async (): Promise<readonly NodeId[]> => {
                if (this.sweep) return [...await this.sweep.finish()];
                for (let attempt = 1; ; attempt++) {
                    try { return await this.context.region(region, this.controller.signal); }
                    catch (error) {
                        if (!isCancellation(error) || this.controller.signal.aborted || !this.valid() || attempt >= REGION_ATTEMPTS) throw error;
                    }
                }
            };
            void query().then(ids => {
                if (!this.valid()) { this.cancel('invalidated'); return; }
                this.context.selection.replace(this.keys.shift ? [...this.initial, ...ids] : ids);
                this.cleanup();
            }).catch(error => this.fail(error));
        } catch (error) { this.fail(error); }
    }
    cancel(reason: CancelReason): void {
        if (this.cleaned) return;
        this.ended = true;
        this.restoreShown();
        try { this.sweep?.cancel(); }
        finally { try { this.transform?.cancel(reason); } finally { this.transform = null; this.cleanup(); } }
    }
}

export const boardSelectTool: Tool<BoardSelectGestureContext> = {
    id: 'select',
    begin(sample, modifiers, context) {
        return context.beginHandle(sample, modifiers) ?? new BoardSelectGesture(sample, modifiers, context,
            modifiers.accel && !!context.brushOverHandle?.(sample));
    },
};
