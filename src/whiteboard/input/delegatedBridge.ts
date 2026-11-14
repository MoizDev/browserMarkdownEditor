import type { InkIdentity, InkPresentation } from './liveInk';
import { DelegatedInk } from './prediction';
import type { MappingHistory, PresentedMapping } from './pointer';
import type { RealSample } from './tool';

export interface PresentedWetSample { readonly identity: InkIdentity; readonly curveSequence: number }
export interface DelegatedBridgeOptions {
    readonly surface: HTMLElement;
    readonly mappings: MappingHistory;
    current(): boolean;
    /** Only called for a wet curve that actually reached presentation. */
    onRealPresented(callback: (sample: PresentedWetSample) => void): () => void;
}
interface InkState { readonly identity: InkIdentity; readonly presentation: InkPresentation; readonly sample: RealSample }
interface Candidate extends InkState { readonly curveSequence: number; readonly predicted: boolean }
interface EventRecord { readonly event: PointerEvent; readonly sample: RealSample; readonly mapping: readonly number[] }
interface Submitted { readonly identity: InkIdentity; readonly curveSequence: number; readonly record: EventRecord; readonly presentation: InkPresentation }

function mappingValues(mapping: PresentedMapping): readonly number[] | null {
    const a = mapping.clientToWorld(0, 0), b = mapping.clientToWorld(1, 0), c = mapping.clientToWorld(0, 1);
    const s = mapping.clientToSurface(0, 0), t = mapping.clientToSurface(1, 0), u = mapping.clientToSurface(0, 1);
    const values = [a.x, a.y, b.x, b.y, c.x, c.y, s.x, s.y, t.x, t.y, u.x, u.y];
    return values.every(Number.isFinite) ? values : null;
}
function sameMapping(a: readonly number[], b: readonly number[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Delegation is an optional compositor capability, never an authoring path.
 * Only a token-matched real-curve presentation may release its trusted event. */
export class DelegatedInkBridge {
    private readonly delegated: DelegatedInk;
    private readonly unsubscribe: () => void;
    private event: EventRecord | null = null;
    private submitted: Submitted | null = null;
    private delegatedPointer: number | null = null;
    private lastSent: { readonly pointerId: number; readonly sequence: number } | null = null;
    private disposed = false;
    constructor(private readonly options: DelegatedBridgeOptions) {
        this.delegated = new DelegatedInk(options.surface);
        this.unsubscribe = options.onRealPresented(value => this.presented(value));
        void this.delegated.attach();
    }
    observe(event: PointerEvent, sample: RealSample): void {
        if (this.disposed || !this.options.current() || !event.isTrusted || sample.source !== 'pen'
            || event.pointerId !== sample.pointerId || event.timeStamp !== sample.time || !event.buttons) {
            this.event = null; this.delegatedPointer = null; return;
        }
        const mapping = this.options.mappings.latest(), values = mapping && mappingValues(mapping);
        if (!values) { this.event = null; this.delegatedPointer = null; return; }
        if (this.event && !sameMapping(this.event.mapping, values)) this.delegatedPointer = null;
        this.event = { event, sample, mapping: values };
    }
    private eligible(candidate: InkState | null): candidate is InkState {
        const record = this.event;
        if (this.disposed || !this.options.current() || !this.delegated.ready || !candidate || !record
            || candidate.sample.pointerId !== record.sample.pointerId || candidate.sample.sequence !== record.sample.sequence
            || candidate.sample.time !== record.sample.time) return false;
        const p = candidate.presentation, m = p.localToWorld;
        const x = Math.hypot(m[0], m[1]), y = Math.hypot(m[2], m[3]), dot = m[0] * m[2] + m[1] * m[3];
        return p.tool === 'pen' && (p.opacity ?? 1) === 1 && (p.clips?.length ?? 0) === 0
            && Number.isFinite(x) && Number.isFinite(y) && x > 0 && Math.abs(x - y) <= 1e-9 * Math.max(1, x, y)
            && Math.abs(dot) <= 1e-9 * Math.max(1, x * y);
    }
    wantsExclusive(candidate: InkState | null): boolean { return this.eligible(candidate); }
    submittedCurve(candidate: Candidate | null): void {
        if (!this.eligible(candidate) || candidate.predicted) { this.submitted = null; this.delegatedPointer = null; return; }
        const record = this.event!;
        if (this.lastSent?.pointerId === record.sample.pointerId && this.lastSent.sequence === record.sample.sequence) {
            this.submitted = null; return;
        }
        this.submitted = { identity: candidate.identity, curveSequence: candidate.curveSequence, record, presentation: candidate.presentation };
    }
    private presented(value: PresentedWetSample): void {
        const submitted = this.submitted;
        if (this.disposed || !this.options.current() || !submitted || submitted.curveSequence !== value.curveSequence
            || submitted.identity.nodeId !== value.identity.nodeId || submitted.identity.gestureSequence !== value.identity.gestureSequence
            || this.event !== submitted.record) return;
        const mapping = this.options.mappings.latest(), values = mapping && mappingValues(mapping);
        if (!values || !sameMapping(values, submitted.record.mapping)) { this.delegatedPointer = null; return; }
        // The two mappings yield world units and CSS-surface units for one client pixel.
        const worldPerClient = Math.hypot(values[2] - values[0], values[3] - values[1]);
        const surfacePerClient = Math.hypot(values[8] - values[6], values[9] - values[7]);
        const m = submitted.presentation.localToWorld, localScale = Math.hypot(m[0], m[1]);
        const diameter = submitted.presentation.width * localScale * surfacePerClient / worldPerClient;
        const accepted = this.delegated.update(submitted.record.event, diameter, submitted.presentation.color, true);
        this.lastSent = { pointerId: submitted.record.sample.pointerId, sequence: submitted.record.sample.sequence };
        this.delegatedPointer = accepted ? submitted.record.sample.pointerId : null;
        this.submitted = null;
    }
    ownsPrediction(pointerId: number): boolean { return !this.disposed && this.options.current() && this.delegatedPointer === pointerId; }
    clear(): void { this.event = null; this.submitted = null; this.delegatedPointer = null; this.lastSent = null; }
    dispose(): void { if (!this.disposed) { this.disposed = true; this.clear(); this.unsubscribe(); this.delegated.detach(); } }
}
