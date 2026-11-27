import { AuthoringSamples } from './canonicalize';
import type { OmissionCertificate } from './canonicalize';
import { PointerDequantizer, type DequantizedSample } from './dequantize';
import { createOmissionCertificate } from './omission';
import { validateSample, type SampleBuilder, type SampleBuilderOptions, type SampleSequence, type SegmentKind } from './samples';

export const CURVE_VERSION = 1;
export const CURVE_CORNER_DOT = -0.5;
export const CURVE_SMOOTH_DOT = 0;
export const CURVE_MIN_CHORD_WORLD = 1e-12;
export const CURVE_CHUNK_SPANS = 256;
export const FAIRING_CONTROL_ERROR_DEVICE_PX = 0.25;
export const INK_ZOOM_CAP_CALIBRATION = Object.freeze({ id: 'M-INK-ZOOM-CAP', status: 'pending' as const });

export const enum CurveFlag {
    Straight = 1, CornerBefore = 2, CornerAfter = 4, Closure = 8, First = 16, Last = 32,
}
export type CurveParameters = Readonly<{
    version: 1;
    fairingToleranceWorld: number;
    declaredMaxScale: number;
    maxDpr: number;
}>;
export type CurveRange = Readonly<{ firstSpan: number; spanCount: number; }>;
export type CurveGeometry = Readonly<{
    firstSpan: number; spanCount: number;
    originX: number; originY: number;
    cubics: Float64Array;
    flags: Uint8Array;
    boundsLocal: Readonly<{ x: number; y: number; w: number; h: number; }>;
}>;
export type CurvePublication = Readonly<{
    sequence: number;
    phase: 'wet-real' | 'dry';
    parameters: CurveParameters;
    samples: SampleSequence;
    finalizedSpanCount: number;
    replaceableTail: CurveGeometry;
    endpointX: number; endpointY: number;
    packingErrorWorld: number;
    closure: CurveClosure;
}>;
export type CurveClosure = Readonly<{ beforeX: number; beforeY: number; afterX: number; afterY: number; }> | null;

export function curveParameters(declaredMaxScale: number, fairingToleranceWorld?: number, maxDpr = 3): CurveParameters {
    const deviceScale = declaredMaxScale * maxDpr;
    if (!Number.isFinite(deviceScale) || declaredMaxScale <= 0 || maxDpr <= 0) throw new RangeError('Invalid declared ink scale');
    const limit = FAIRING_CONTROL_ERROR_DEVICE_PX / deviceScale;
    const tolerance = fairingToleranceWorld ?? limit;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > limit) throw new RangeError('Saved fairing tolerance exceeds the v1 bound');
    return Object.freeze({ version: CURVE_VERSION, fairingToleranceWorld: tolerance, declaredMaxScale, maxDpr });
}

function validateParameters(p: CurveParameters): void {
    const scale = p.declaredMaxScale * p.maxDpr;
    if (p.version !== CURVE_VERSION || !Number.isFinite(scale) || p.declaredMaxScale <= 0 || p.maxDpr <= 0
        || !Number.isFinite(p.fairingToleranceWorld) || p.fairingToleranceWorld < 0
        || p.fairingToleranceWorld > FAIRING_CONTROL_ERROR_DEVICE_PX / scale) throw new RangeError('Invalid saved v1 ink curve parameters');
}

// Bound used by every enclosure (stroke bounds, notebook growth): each control lies EXACTLY one
// third of its span's chord from that span's endpoint, whatever the branch, and a cubic lies in the
// hull of its four controls, so a span never leaves the discs of radius chord/3 around its samples
// (CURVE_CONTROL_REACH, accumulated by `CurveReach` in ink/reach.ts).

function writeControl(out: Float64Array, offset: number, ax: number, ay: number, bx: number, by: number,
    neighbourX: number, neighbourY: number, hasNeighbour: boolean, isEnd: boolean): boolean {
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    const baseX = isEnd ? bx - dx / 3 : ax + dx / 3;
    const baseY = isEnd ? by - dy / 3 : ay + dy / 3;
    if (!Number.isFinite(baseX) || !Number.isFinite(baseY) || !Number.isFinite(length)) throw new RangeError('Ink control overflow');
    out[offset] = baseX; out[offset + 1] = baseY;
    if (!hasNeighbour || length <= CURVE_MIN_CHORD_WORLD) return length <= CURVE_MIN_CHORD_WORLD;
    const nx = isEnd ? neighbourX - bx : ax - neighbourX;
    const ny = isEnd ? neighbourY - by : ay - neighbourY;
    const neighbourLength = Math.hypot(nx, ny);
    if (neighbourLength <= CURVE_MIN_CHORD_WORLD) return true;
    const ux = dx / length, uy = dy / length;
    const dot = ux * nx / neighbourLength + uy * ny / neighbourLength;
    if (dot <= CURVE_CORNER_DOT) return true;
    const sumX = dx + nx, sumY = dy + ny, sumLength = Math.hypot(sumX, sumY);
    if (!(sumLength > CURVE_MIN_CHORD_WORLD)) return true;
    let tangentX = sumX / sumLength, tangentY = sumY / sumLength;
    if (dot < CURVE_SMOOTH_DOT) {
        const t = (CURVE_SMOOTH_DOT - dot) / (CURVE_SMOOTH_DOT - CURVE_CORNER_DOT), w = t * t * (3 - 2 * t);
        const blendX = tangentX + (ux - tangentX) * w, blendY = tangentY + (uy - tangentY) * w;
        const blendLength = Math.hypot(blendX, blendY);
        if (!(blendLength > 0)) return true;
        tangentX = blendX / blendLength; tangentY = blendY / blendLength;
    }
    const sign = isEnd ? -1 : 1, handle = length / 3;
    const controlX = (isEnd ? bx : ax) + sign * tangentX * handle;
    const controlY = (isEnd ? by : ay) + sign * tangentY * handle;
    if (!Number.isFinite(controlX) || !Number.isFinite(controlY)) throw new RangeError('Ink control overflow');
    out[offset] = controlX; out[offset + 1] = controlY;
    return false;
}

export function curveClosure(samples: SampleSequence, closed: boolean): CurveClosure {
    const last = samples.count - 1;
    if (!closed || samples.count < 4 || samples.x(0) !== samples.x(last) || samples.y(0) !== samples.y(last)
        || samples.segmentKind(0) !== 'freehand' || samples.segmentKind(last - 1) !== 'freehand') return null;
    return Object.freeze({ beforeX: samples.x(last - 1), beforeY: samples.y(last - 1), afterX: samples.x(1), afterY: samples.y(1) });
}

export function writeCurveSpan(samples: SampleSequence, index: number, p: CurveParameters,
    output: Float64Array, offset = 0, endpointLimit = samples.count, closure: CurveClosure = null): number {
    validateParameters(p);
    if (!Number.isInteger(index) || !Number.isInteger(endpointLimit) || !Number.isInteger(offset)
        || index < 0 || index + 1 >= endpointLimit || endpointLimit > samples.count
        || offset < 0 || offset + 8 > output.length) throw new RangeError('Invalid cubic span range');
    const ax = samples.x(index), ay = samples.y(index), bx = samples.x(index + 1), by = samples.y(index + 1);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
        throw new RangeError('Ink position must be finite');
    }
    output[offset] = ax; output[offset + 1] = ay; output[offset + 6] = bx; output[offset + 7] = by;
    let flags = (index === 0 ? CurveFlag.First : 0) | (index + 2 === endpointLimit ? CurveFlag.Last : 0);
    const straight = samples.segmentKind(index) === 'straight';
    const before = !straight && index > 0 && samples.segmentKind(index - 1) === 'freehand';
    const after = !straight && index + 2 < endpointLimit && samples.segmentKind(index + 1) === 'freehand';
    const join = !straight && closure && endpointLimit === samples.count ? closure : null;
    const opening = !!join && index === 0, closing = !!join && index + 2 === samples.count;
    if (writeControl(output, offset + 2, ax, ay, bx, by,
        before ? samples.x(index - 1) : opening ? join!.beforeX : 0, before ? samples.y(index - 1) : opening ? join!.beforeY : 0,
        before || opening, false)) flags |= CurveFlag.CornerBefore;
    if (writeControl(output, offset + 4, ax, ay, bx, by,
        after ? samples.x(index + 2) : closing ? join!.afterX : 0, after ? samples.y(index + 2) : closing ? join!.afterY : 0,
        after || closing, true)) flags |= CurveFlag.CornerAfter;
    if (straight || endpointLimit === 2) flags |= CurveFlag.Straight;
    return flags;
}

export function materializeCurveRange(samples: SampleSequence, range: CurveRange, p: CurveParameters,
    closure: CurveClosure = null): CurveGeometry {
    validateParameters(p);
    const { firstSpan, spanCount } = range;
    if (!Number.isInteger(firstSpan) || !Number.isInteger(spanCount) || firstSpan < 0 || spanCount < 0
        || firstSpan + spanCount > Math.max(0, samples.count - 1) || spanCount > CURVE_CHUNK_SPANS) {
        throw new RangeError('Invalid visible curve chunk');
    }
    const originX = samples.count ? samples.x(firstSpan) : 0, originY = samples.count ? samples.y(firstSpan) : 0;
    const cubics = new Float64Array(8 * spanCount), flags = new Uint8Array(spanCount);
    let minX = originX, minY = originY, maxX = originX, maxY = originY;
    for (let i = 0; i < spanCount; i++) {
        const offset = 8 * i;
        flags[i] = writeCurveSpan(samples, firstSpan + i, p, cubics, offset, samples.count, closure);
        for (let j = 0; j < 8; j += 2) {
            minX = Math.min(minX, cubics[offset + j]); maxX = Math.max(maxX, cubics[offset + j]);
            minY = Math.min(minY, cubics[offset + j + 1]); maxY = Math.max(maxY, cubics[offset + j + 1]);
            cubics[offset + j] -= originX; cubics[offset + j + 1] -= originY;
        }
    }
    return Object.freeze({
        firstSpan, spanCount, originX, originY, cubics, flags,
        boundsLocal: Object.freeze({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
    });
}

function packingDisplacement(before: SampleSequence, after: SampleSequence, firstSpan: number,
    spanCount: number, p: CurveParameters): number {
    const original = new Float64Array(8), packed = new Float64Array(8);
    let bound = 0, magnitude = 1;
    for (let i = firstSpan; i < firstSpan + spanCount; i++) {
        writeCurveSpan(before, i, p, original);
        writeCurveSpan(after, i, p, packed);
        for (let j = 0; j < 8; j += 2) {
            bound = Math.max(bound, Math.hypot(original[j] - packed[j], original[j + 1] - packed[j + 1]));
            magnitude = Math.max(magnitude, Math.abs(original[j]), Math.abs(original[j + 1]), Math.abs(packed[j]), Math.abs(packed[j + 1]));
        }
    }
    return bound === 0 ? 0 : bound + 64 * Number.EPSILON * magnitude;
}

function withTail(base: SampleSequence, tail: readonly DequantizedSample[]): SampleSequence {
    const prefix = base.count, count = prefix + tail.length;
    const check = (i: number) => { if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError('Invalid authoring sample index'); };
    return Object.freeze({
        count,
        x: (i: number) => { check(i); return i < prefix ? base.x(i) : tail[i - prefix].x; },
        y: (i: number) => { check(i); return i < prefix ? base.y(i) : tail[i - prefix].y; },
        pressure: (i: number) => { check(i); return i < prefix ? base.pressure(i) : tail[i - prefix].pressure; },
        segmentKind: (i: number) => { check(i); check(i + 1); return i + 1 < prefix ? base.segmentKind(i) : tail[i + 1 - prefix].kind; },
    });
}

export class LocalCurveBuilder {
    readonly samples: AuthoringSamples;
    readonly parameters: CurveParameters;
    private sequence = 0;
    private completed = false;
    private readonly dequantizer: PointerDequantizer | undefined;
    constructor(options: SampleBuilderOptions, captureDeviceScale: number,
        fairingToleranceWorld?: number, certificate?: OmissionCertificate, inputPixelWorld?: number) {
        this.parameters = curveParameters(options.declaredMaxScale, fairingToleranceWorld, options.maxDpr ?? 3);
        this.samples = new AuthoringSamples(options, captureDeviceScale, certificate ?? createOmissionCertificate(this.parameters),
            (before, after, first, count) => packingDisplacement(before, after, first, count, this.parameters));
        this.dequantizer = inputPixelWorld === undefined ? undefined : new PointerDequantizer(inputPixelWorld, captureDeviceScale);
    }
    append(x: number, y: number, pressure: number | undefined, incomingKind: SegmentKind = 'freehand', pins = 0): void {
        if (this.completed) throw new Error('Completed ink cannot be extended by a later release event');
        if (!this.dequantizer) { this.samples.append(x, y, pressure, incomingKind, pins); return; }
        validateSample(x, y, pressure, this.samples.options.pressure);
        for (const s of this.dequantizer.push(x, y, pressure, incomingKind, pins)) this.samples.append(s.x, s.y, s.pressure, s.kind, s.pins);
    }
    publish(): CurvePublication {
        if (this.completed) throw new Error('Completed ink has already published its final prefix');
        const base = this.samples.snapshot(), tail = this.dequantizer?.provisional() ?? [];
        const packet = this.publication(base, tail);
        this.samples.markPublished();
        return packet;
    }
    private publication(base: SampleSequence, tail: readonly DequantizedSample[]): CurvePublication {
        const samples = tail.length ? withTail(base, tail) : base;
        if (!samples.count) throw new Error('Empty ink has no geometry publication');
        const spanCount = samples.count - 1;
        const finalizedSpanCount = Math.max(0, base.count - 4);
        const sequence = ++this.sequence;
        return Object.freeze({
            sequence, phase: 'wet-real', parameters: this.parameters, samples,
            finalizedSpanCount,
            replaceableTail: materializeCurveRange(samples, { firstSpan: finalizedSpanCount, spanCount: spanCount - finalizedSpanCount }, this.parameters),
            endpointX: samples.x(samples.count - 1), endpointY: samples.y(samples.count - 1),
            packingErrorWorld: this.samples.packingErrorWorld, closure: null,
        });
    }
    finish(): Readonly<{ samples: SampleBuilder; publication: CurvePublication; }> {
        if (this.completed) throw new Error('Ink has already completed');
        for (const s of this.dequantizer?.flush() ?? []) this.samples.append(s.x, s.y, s.pressure, s.kind, s.pins);
        const canonical = this.samples.snapshot(), publication = this.publication(canonical, []);
        const samples = this.samples.finish();
        this.completed = true;
        return Object.freeze({ samples, publication });
    }
}

export function closeCurvePublication(publication: CurvePublication, closure: CurveClosure): CurvePublication {
    if (!closure) return publication;
    const { samples, parameters } = publication;
    return Object.freeze({ ...publication, closure, finalizedSpanCount: 0, replaceableTail: materializeCurveRange(samples,
        { firstSpan: 0, spanCount: Math.min(CURVE_CHUNK_SPANS, samples.count - 1) }, parameters, closure) });
}

export type InkRevision = Readonly<{ nodeId: string; nodeRevision: number; gestureSequence: number; }>;
export function chooseInkPhase(wet: InkRevision, readyDry: InkRevision | null): 'wet-real' | 'dry' {
    // The compositor makes this ONE choice for all bands in a frame. Until the exact dry revision is
    // drawable, keep wet real ink; never draw both (dark overlap) or neither (one-frame hole).
    return readyDry && wet.nodeId === readyDry.nodeId && wet.nodeRevision === readyDry.nodeRevision
        && wet.gestureSequence === readyDry.gestureSequence ? 'dry' : 'wet-real';
}
