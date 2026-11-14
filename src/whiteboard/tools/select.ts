import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample, Tool } from '../input/tool';
import type { NodeId } from '../model/ids';
import { SelectionState } from '../selection';
import type { Vec2 } from '../geom/path';

export type SelectRegion =
    | Readonly<{ kind: 'marquee'; start: Vec2; end: Vec2; containment: boolean }>
    | Readonly<{ kind: 'scribble'; points: readonly Vec2[] }>;
export interface SelectToolContext {
    readonly selection: SelectionState;
    readonly dragThresholdCss: number;
    toSurface(point: Vec2): Vec2;
    isCurrent(): boolean;
    hit(sample: RealSample, signal: AbortSignal): Promise<NodeId | null>;
    region(region: SelectRegion, signal: AbortSignal): Promise<readonly NodeId[]>;
    preview(region: SelectRegion | null): void;
    beginTransform(sample: RealSample, hit: NodeId, modifiers: Modifiers): GestureOwner;
    onError(error: unknown): void;
}
const point = (sample: RealSample): Vec2 => ({ x: sample.x, y: sample.y });

class SelectGesture implements GestureOwner {
    readonly pointerIds: ReadonlySet<number>;
    readonly kind = 'marquee' as const;
    private readonly controller = new AbortController();
    private readonly initial: readonly NodeId[];
    private readonly scribbleIntent: boolean;
    private readonly startModifiers: Modifiers;
    private readonly samples: RealSample[] = [];
    private hitId: NodeId | null | undefined;
    private modifiers: Modifiers;
    private dragging = false;
    private transform: GestureOwner | null = null;
    private ended: FinishReason | null = null;
    private cancelled = false;
    constructor(private readonly down: RealSample, modifiers: Modifiers, private readonly context: SelectToolContext) {
        this.pointerIds = new Set([down.pointerId]); this.modifiers = modifiers;
        this.initial = context.selection.getSnapshot().selected; this.scribbleIntent = modifiers.alt; this.startModifiers = modifiers;
        context.hit(down, this.controller.signal).then(id => {
            if (!this.valid()) return;
            this.hitId = id;
            if (this.dragging) this.activateDrag();
            if (this.ended) this.complete(this.ended);
        }).catch(error => { if (!this.controller.signal.aborted) { this.cancel('invalidated'); context.onError(error); } });
    }
    private valid(): boolean { return !this.cancelled && this.context.isCurrent() && !this.controller.signal.aborted; }
    private currentRegion(): SelectRegion {
        const last = this.samples[this.samples.length - 1] ?? this.down;
        return this.scribbleIntent && this.hitId === null
            ? { kind: 'scribble', points: [point(this.down), ...this.samples.map(point)] }
            : { kind: 'marquee', start: point(this.down), end: point(last), containment: this.modifiers.control };
    }
    private activateDrag(): void {
        if (!this.valid() || this.hitId === undefined || this.transform) return;
        if (this.hitId !== null) {
            if (!this.context.selection.getSnapshot().selected.includes(this.hitId)) this.context.selection.replace([this.hitId]);
            this.transform = this.context.beginTransform(this.down, this.hitId, this.startModifiers);
            if (this.samples.length) this.transform.update(this.samples, this.modifiers);
        } else this.context.preview(this.currentRegion());
    }
    update(samples: readonly RealSample[], modifiers: Modifiers): void {
        if (!this.valid() || this.ended) return;
        this.modifiers = modifiers;
        for (const sample of samples) if (sample.pointerId === this.down.pointerId) this.samples.push(sample);
        const last = this.samples[this.samples.length - 1];
        if (last && !this.dragging) {
            const a = this.context.toSurface(point(this.down)), b = this.context.toSurface(point(last));
            this.dragging = Math.hypot(a.x - b.x, a.y - b.y) >= this.context.dragThresholdCss;
        }
        if (this.transform) this.transform.update(samples, modifiers);
        else if (this.dragging) this.activateDrag();
    }
    finish(reason: FinishReason): void {
        if (!this.valid() || this.ended) return;
        if (reason !== 'up' && !this.transform) { this.cancel(reason === 'undo' ? 'undo' : reason === 'escape' ? 'escape' : 'invalidated'); return; }
        this.ended = reason;
        if (this.hitId !== undefined) this.complete(reason);
    }
    private complete(reason: FinishReason): void {
        if (!this.valid()) return;
        this.context.preview(null);
        if (this.transform) { this.transform.finish(reason); this.cancelled = true; this.controller.abort(); return; }
        if (!this.dragging) {
            if (this.hitId === null) { if (!this.modifiers.shift) this.context.selection.clear(); }
            else if (this.hitId !== undefined) {
                if (this.modifiers.shift) this.context.selection.toggle(this.hitId);
                else this.context.selection.replace([this.hitId]);
            }
            this.cancelled = true; this.controller.abort(); return;
        }
        const region = this.currentRegion();
        this.context.region(region, this.controller.signal).then(ids => {
            if (!this.valid()) return;
            this.context.selection.replace(this.modifiers.shift ? [...this.initial, ...ids] : ids);
            this.cancelled = true; this.controller.abort();
        }).catch(error => { if (!this.controller.signal.aborted) { this.cancel('invalidated'); this.context.onError(error); } });
    }
    cancel(reason: CancelReason): void {
        if (this.cancelled) return;
        this.cancelled = true; this.controller.abort(); this.context.preview(null);
        this.transform?.cancel(reason);
    }
}
export const selectTool: Tool<SelectToolContext> = {
    id: 'select',
    begin(sample, modifiers, context) { return new SelectGesture(sample, modifiers, context); },
};
