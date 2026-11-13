import type { SampleBuilderOptions, SampleSequence, SegmentKind } from './samples';
import { SampleBuilder, validateSample } from './samples';

export const AUTHORING_WINDOW_CAPACITY = 64;
export const CANONICALIZATION_ERROR_DEVICE_PX = 0.1;
export const CANONICALIZATION_FLATTEN_ERROR_DEVICE_PX = 0.01;
export const CANONICALIZATION_DIRECTED_ERROR_DEVICE_PX = 0.08;
export const enum SamplePin { Corner = 1, RunBoundary = 2, Closure = 4, PressureExtremum = 8 }

export interface CanonicalizationCandidate {
    readonly rawCount: number;
    readonly retainedCount: number;
    readonly rawXY: Float64Array;
    readonly rawPressure: Float64Array;
    readonly incomingKinds: Uint8Array;
    readonly pins: Uint8Array;
    readonly retained: Uint8Array;
    readonly publishedRawCount: number;
    readonly captureDeviceScale: number;
}
// One candidate, at most three affected cubics. W-E1b can replace this certificate without changing
// the store/curve: inconclusive is false, never a sampled-distance guess that silently drops ink.
export type OmissionCertificate = (candidate: CanonicalizationCandidate) => boolean;
export type PackingCertificate = (before: SampleSequence, after: SampleSequence, firstSpan: number, spanCount: number) => number;
// Half of §6.1's 1/16 px packing allocation remains for later GPU packing; it is NOT extra error.
export const SAMPLE_CURVE_PACKING_ERROR_DEVICE_PX = 1 / 32;

export const certifyExactCollinear: OmissionCertificate = (c) => {
    if (c.retainedCount < 3) return false;
    const b = c.retained[c.retainedCount - 2];
    if (c.pins[b]) return false;
    const ax = c.rawXY[0], ay = c.rawXY[1];
    const last = c.rawCount - 1, dx = c.rawXY[2 * last] - ax, dy = c.rawXY[2 * last + 1] - ay;
    if (dx === 0 && dy === 0) return false;
    // Axis-aligned doubles give an exact enclosure. General integer lines also have an exact
    // determinant when differences/products fit 52 bits; controls may still round off that line,
    // so E1 conservatively keeps those for the full curved certificate rather than assert equality.
    if (dx !== 0 && dy !== 0) return false;
    const pressure = c.rawPressure[0];
    let previous = dx === 0 ? ay : ax;
    for (let i = 0; i < c.rawCount; i++) {
        const x = c.rawXY[2 * i], y = c.rawXY[2 * i + 1];
        if (c.incomingKinds[i] !== 0 || c.rawPressure[i] !== pressure || (i > 0 && c.pins[i])) return false;
        if (dx === 0 ? x !== ax : y !== ay) return false;
        const position = dx === 0 ? y : x, direction = dx === 0 ? dy : dx;
        if (direction > 0 ? position < previous : position > previous) return false;
        previous = position;
    }
    // Every old/proposed cubic is monotone on the very same interval with the same radius. Their
    // symmetric swept coverage distance is exactly zero, including the last published prefix. This
    // uses all raw points, not a chain of pairwise omissions whose errors could accumulate.
    return true;
};

export class AuthoringSamples implements SampleSequence, CanonicalizationCandidate {
    readonly rawXY = new Float64Array(2 * AUTHORING_WINDOW_CAPACITY);
    readonly rawPressure = new Float64Array(AUTHORING_WINDOW_CAPACITY);
    readonly incomingKinds = new Uint8Array(AUTHORING_WINDOW_CAPACITY);
    readonly pins = new Uint8Array(AUTHORING_WINDOW_CAPACITY);
    readonly retained = new Uint8Array(AUTHORING_WINDOW_CAPACITY);
    rawCount = 0;
    retainedCount = 0;
    publishedRawCount = 0;
    received = 0;
    certifiedOmitted = 0;
    exactRedundant = 0;
    private finished = false;
    private packingSincePublication = 0;
    get packingErrorWorld(): number { return this.packingSincePublication; }
    readonly frozen: SampleBuilder;
    readonly options: SampleBuilderOptions;
    constructor(options: SampleBuilderOptions, readonly captureDeviceScale: number,
        private readonly certify: OmissionCertificate = certifyExactCollinear,
        private readonly certifyPacking?: PackingCertificate) {
        if (!Number.isFinite(captureDeviceScale) || captureDeviceScale <= 0) throw new RangeError('Invalid capture scale');
        this.options = Object.freeze({ ...options });
        this.frozen = new SampleBuilder(this.options);
    }
    get count(): number { return this.frozen.count + this.retainedCount; }
    append(x: number, y: number, pressure: number | undefined, incomingKind: SegmentKind = 'freehand', pins = 0): void {
        if (this.finished) throw new Error('A finished authoring window cannot be extended');
        validateSample(x, y, pressure, this.options.pressure);
        this.received++;
        const p = pressure ?? -1, last = this.rawCount - 1, kind = incomingKind === 'straight' ? 1 : 0;
        if (last >= 0 && this.rawXY[2 * last] === x && this.rawXY[2 * last + 1] === y
            && this.rawPressure[last] === p && this.incomingKinds[last] === kind && !pins) {
            this.exactRedundant++;
            return;
        }
        if (this.rawCount === AUTHORING_WINDOW_CAPACITY) this.freezePrefix();
        const i = this.rawCount++;
        this.rawXY[2 * i] = x; this.rawXY[2 * i + 1] = y;
        this.rawPressure[i] = p; this.incomingKinds[i] = kind; this.pins[i] = pins;
        if (i && this.incomingKinds[i - 1] !== kind) this.pins[i - 1] |= SamplePin.RunBoundary;
        if (this.retainedCount >= 2) {
            const a = this.retained[this.retainedCount - 2], b = this.retained[this.retainedCount - 1];
            const before = this.rawPressure[b] - this.rawPressure[a], after = p - this.rawPressure[b];
            if (before * after < 0 || (before === 0 && after !== 0) || (after === 0 && before !== 0)) {
                this.pins[b] |= SamplePin.PressureExtremum;
            }
        }
        this.retained[this.retainedCount++] = i;
        if (this.retainedCount >= 3 && this.certify(this)) {
            this.retained[this.retainedCount - 2] = i;
            this.retainedCount--;
            this.certifiedOmitted++;
        }
    }
    markPublished(): void { this.publishedRawCount = this.rawCount; this.packingSincePublication = 0; }
    snapshot(skippedRetained = 0): SampleSequence {
        const frozen = this.frozen.snapshot(), tailCount = this.retainedCount - skippedRetained;
        const count = frozen.count + tailCount;
        const xy = new Float64Array(2 * tailCount), p = new Float64Array(tailCount), kinds = new Uint8Array(tailCount);
        for (let i = 0; i < tailCount; i++) {
            const source = this.retained[i + skippedRetained];
            xy[2 * i] = this.rawXY[2 * source]; xy[2 * i + 1] = this.rawXY[2 * source + 1];
            p[i] = this.rawPressure[source]; kinds[i] = this.incomingKinds[source];
        }
        const check = (i: number) => {
            if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError('Invalid authoring sample index');
        };
        return Object.freeze({
            count,
            x: (i: number) => { check(i); return i < frozen.count ? frozen.x(i) : xy[2 * (i - frozen.count)]; },
            y: (i: number) => { check(i); return i < frozen.count ? frozen.y(i) : xy[2 * (i - frozen.count) + 1]; },
            pressure: (i: number) => {
                check(i);
                if (i < frozen.count) return frozen.pressure(i);
                const value = p[i - frozen.count];
                return value < 0 ? undefined : value;
            },
            segmentKind: (i: number) => {
                check(i); check(i + 1);
                return i + 1 < frozen.count ? frozen.segmentKind(i) : kinds[i + 1 - frozen.count] ? 'straight' : 'freehand';
            },
        });
    }
    private freezePrefix(): void {
        // Three retained neighbours remain exact; the next candidate can affect no earlier tangent.
        // R-W9: packing is provisional until a whole affected-control-hull certificate admits it.
        const keep = Math.min(3, this.retainedCount), stop = this.retainedCount - keep;
        if (stop) {
            const before = this.snapshot(), oldFrozenCount = this.frozen.count;
            const rollback = this.frozen.checkpoint();
            for (let j = 0; j < stop; j++) this.appendFrozen(this.retained[j]);
            const firstSpan = Math.max(0, oldFrozenCount - 3);
            const endSpan = Math.min(before.count - 1, this.frozen.count + 1);
            const error = this.certifyPacking?.(before, this.snapshot(stop), firstSpan, endSpan - firstSpan) ?? Infinity;
            const budget = Math.min(CANONICALIZATION_ERROR_DEVICE_PX / this.captureDeviceScale,
                SAMPLE_CURVE_PACKING_ERROR_DEVICE_PX / (this.options.declaredMaxScale * (this.options.maxDpr ?? 3)));
            if (!Number.isFinite(error) || error < 0 || this.packingSincePublication + error > budget) {
                // A tiny positional rounding can cross a tangent/corner threshold. Keep doubles rather
                // than trust the sample-error name; no published array or canonical record is rolled back.
                rollback();
                this.frozen.beginExactTail();
                for (let j = 0; j < stop; j++) this.appendFrozen(this.retained[j]);
                this.frozen.beginBoundedChunk();
            } else this.packingSincePublication += error;
        }
        for (let j = 0; j < keep; j++) {
            const source = this.retained[stop + j];
            this.rawXY[2 * j] = this.rawXY[2 * source]; this.rawXY[2 * j + 1] = this.rawXY[2 * source + 1];
            this.rawPressure[j] = this.rawPressure[source]; this.incomingKinds[j] = this.incomingKinds[source];
            this.pins[j] = this.pins[source]; this.retained[j] = j;
        }
        this.rawCount = keep; this.retainedCount = keep; this.publishedRawCount = 0;
    }
    private appendFrozen(i: number): void {
        this.frozen.append(this.rawXY[2 * i], this.rawXY[2 * i + 1],
            this.options.pressure ? this.rawPressure[i] : undefined, this.incomingKinds[i] ? 'straight' : 'freehand');
    }
    private rawIndex(index: number): number {
        if (!Number.isInteger(index) || index < this.frozen.count || index >= this.count) throw new RangeError('Invalid authoring sample index');
        return this.retained[index - this.frozen.count];
    }
    x(index: number): number { return index < this.frozen.count ? this.frozen.x(index) : this.rawXY[2 * this.rawIndex(index)]; }
    y(index: number): number { return index < this.frozen.count ? this.frozen.y(index) : this.rawXY[2 * this.rawIndex(index) + 1]; }
    pressure(index: number): number | undefined {
        if (index < this.frozen.count) return this.frozen.pressure(index);
        const p = this.rawPressure[this.rawIndex(index)];
        return p < 0 ? undefined : p;
    }
    segmentKind(index: number): SegmentKind {
        if (!Number.isInteger(index) || index < 0 || index + 1 >= this.count) throw new RangeError('Invalid authoring span index');
        if (index + 1 < this.frozen.count) return this.frozen.segmentKind(index);
        return this.incomingKinds[this.rawIndex(index + 1)] ? 'straight' : 'freehand';
    }
    finish(): SampleBuilder {
        if (this.finished) throw new Error('Authoring ownership has already transferred');
        // No omission/packing at pointer-up/save/hide. Keeping this bounded tail in doubles prevents a
        // commit-time refit; the already frozen prefix stays in its bounded canonical representation.
        this.frozen.beginExactTail();
        for (let j = 0; j < this.retainedCount; j++) this.appendFrozen(this.retained[j]);
        this.rawCount = 0; this.retainedCount = 0; this.finished = true;
        return this.frozen;
    }
}
