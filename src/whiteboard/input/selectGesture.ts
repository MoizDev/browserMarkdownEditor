import type { Vec2 } from '../geom/path';
import type { NodeId } from '../model/ids';
import type { SelectRegion, SelectToolContext } from '../tools/select';
import { SweepQueue, type SweepQueueServices } from './sweepQueue';
import { sampleSurface, type CancelReason, type FinishReason, type GestureOwner, type Modifiers, type RealSample, type Tool } from './tool';

export interface BoardSelectGestureContext extends SelectToolContext {
    readonly sampleToSurface: (sample: RealSample) => Vec2;
    beginHandle(sample: RealSample, modifiers: Modifiers): GestureOwner | null;
    /** The press lies inside the drawn selection frame (world point at the frame presented at its time). */
    insideSelection(sample: RealSample): boolean;
    /** The press lands on the selection: its picture may be built at rest before the drag that may follow. */
    prewarm?(): void;
    /** The user's wrap-mode preference: a brush then selects only what it fully encloses, and accel inverts it for one gesture. */
    readonly wrapMode?: () => boolean;
    /** The press lies on a resize or rotate handle of the selection frame (accel turns such a drag into a brush). */
    selectionHandleAt?(sample: RealSample): boolean;
    /** An empty press that clears the selection leaves a focused group whose bounds it lies outside (catalogue S§4.6). */
    leaveFocusAt?(point: Vec2): void;
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
    /** Empty space inside the selection frame: a drag moves the whole selection, as a person expects
     * after a marquee over handwriting (measured: a press between strokes started a second marquee). */
    private body = false;
    private dragging = false;
    private ended = false;
    private finishing = false;
    private cleaned = false;
    private transform: GestureOwner | null = null;
    /** The Alt state the live move was started with: a change while moving switches between moving and cloning. */
    private transformAlt = false;
    private sweep: SweepQueue | null = null;
    private sweepLast: Vec2;
    private sweepPreview: ReadonlySet<NodeId> = new Set();
    private readonly points: Vec2[];
    /** The selection the brush has written while dragging (catalogue S§5: hits show live, Escape restores the start).
     * Null until the first write; a cancel restores `initial` only while the selection still holds exactly these ids. */
    private shown: readonly NodeId[] | null = null;
    /** One rectangle query in flight at a time; a move during it marks the latest region dirty, so the last move always lands. */
    private liveBusy = false;
    private liveDirty = false;

    constructor(private readonly down: RealSample, keys: Modifiers, private readonly context: BoardSelectGestureContext) {
        this.pointerIds = new Set([down.pointerId]); this.last = down; this.keys = keys; this.startKeys = keys;
        this.downSurface = sampleSurface(down, context.sampleToSurface);
        this.selectionFence = context.selection.getSnapshot(); this.initial = this.selectionFence.selected;
        this.sweepLast = { x: down.x, y: down.y }; this.points = [this.sweepLast];
        this.release = context.hold();
        try {
            this.unregister = context.registerPending(() => this.cancel('invalidated'));
            if (keys.alt) this.startSweep();
            void context.hit(down, this.controller.signal).then(id => {
                if (!this.valid()) { this.cancel('invalidated'); return; }
                this.hit = id;
                // A selection handle is not a body press: accel-drag from a handle brushes (crop and resize are the handle's own gestures).
                this.body = id === null && !this.startKeys.shift && !this.startKeys.alt && this.initial.length > 0
                    && context.insideSelection(down) && !(this.startKeys.accel && context.selectionHandleAt?.(down));
                if (this.body || (id !== null && this.initial.includes(id))) context.prewarm?.();
                if (id !== null && this.sweep) { this.sweep.cancel(); this.sweep = null; this.points.length = 1; }
                if (this.dragging) this.activateDrag();
                if (this.ended) this.complete();
            }).catch(error => this.fail(error));
        } catch (error) { this.cancel('invalidated'); throw error; }
    }

    /** Alt on empty canvas scribbles: the path from here is swept, and pressing or releasing Alt mid-brush switches the mode. */
    private startSweep(): void {
        const services: SweepQueueServices = { ...this.context.scribble,
            preview: ids => {
                this.sweepPreview = ids;
                if (this.hit === null && this.dragging && this.valid()) this.context.scribble.preview(ids);
                // The scribble's hits are the sweep's visible set, cumulative over the path so far: they select as they arrive.
                if (this.hit === null && this.dragging) this.showSelection([...ids]);
            } };
        this.sweep = new SweepQueue(services);
        this.sweep.add(this.sweepLast, this.sweepLast, false);
    }
    private valid(): boolean {
        // The fence guards the hit/marquee decision. A running transform republishes the selection
        // snapshot as it moves; it owns its own validity, and the fence cancelled every drag-move.
        return !this.cleaned && !this.controller.signal.aborted && this.context.isCurrent()
            && (this.transform !== null || this.context.selection.getSnapshot() === this.selectionFence);
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
        return this.keys.alt && this.hit === null
            ? { kind: 'scribble', points: this.points }
            : { kind: 'marquee', start: { x: this.down.x, y: this.down.y }, end: { x: this.last.x, y: this.last.y }, containment: this.containment() };
    }
    /** Wrap mode (the preference) selects only what the brush fully encloses; accel inverts it for this gesture. */
    private containment(): boolean {
        return (this.context.wrapMode?.() ?? false) !== this.keys.accel;
    }
    private activateDrag(): void {
        if (!this.valid() || this.hit === undefined || this.transform) return;
        if (this.body) this.beginMove(this.initial[0]);
        else if (this.hit !== null && !this.startKeys.accel) {
            if (!this.context.selection.getSnapshot().selected.includes(this.hit)) {
                // Default: Shift-drag adds the hit before moving; Shift-click still toggles on release.
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
    /** Writes the brush's hits to the selection as it moves, so a shape the brush or scribble reaches is selected while the
     * drag is still going (catalogue S§5, S§6). Shift keeps the starting selection, as the release does. */
    private showSelection(ids: readonly NodeId[]): void {
        if (this.ended || this.cleaned || !this.valid()) return;
        const next = [...new Set(this.keys.shift ? [...this.initial, ...ids] : ids)];
        const current = this.selectionFence.selected;
        if (current.length === next.length && next.every(id => current.includes(id))) return;
        this.context.selection.replace(next);
        this.selectionFence = this.context.selection.getSnapshot();
        this.shown = this.selectionFence.selected;
    }
    /** Rectangle hits for the current region, one query at a time: a move that arrives during a query re-runs it once it lands. */
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
    /** A cancelled brush gives back the selection it started with, but only while nothing else has changed it since. */
    private restoreShown(): void {
        const shown = this.shown;
        this.shown = null;
        if (!shown) return;
        const current = this.context.selection.getSnapshot().selected;
        if (current.length === shown.length && shown.every(id => current.includes(id))) this.context.selection.replace(this.initial);
    }
    /** A move of `hit`, cloned while Alt is held (catalogue S§7.4). The move is relative to the press, so a switch restarts it
     * from the current pointer without a jump. */
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
                // Alt pressed or released mid-move: clone or move the originals from here (catalogue S§7.4).
                const previous = this.transform; this.transform = null; previous.cancel('invalidated');
                if (this.dragging) this.activateDrag();
            }
            else if (this.transform) this.transform.update(samples, keys);
            else if (this.dragging) this.activateDrag();
            // Alt pressed or released mid-brush switches between the rectangle and the scribble (catalogue S§5, S§6).
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
                // Shift and accel both add or remove; alt replaces the selection (catalogue S§4.3-4.6).
                const additive = (this.keys.shift || this.keys.accel) && !this.keys.alt;
                if (this.hit === null) {
                    if (!additive) { this.context.selection.clear(); this.context.leaveFocusAt?.({ x: this.down.x, y: this.down.y }); }
                }
                else if (this.hit !== undefined) {
                    if (additive) this.context.selection.toggle(this.hit);
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
        // Set before the sweep is drained: its empty preview must not write the selection while the cancel gives it back.
        this.ended = true;
        this.restoreShown();
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
