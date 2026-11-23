import { AuthoringSamples } from './canonicalize';
import type { OmissionCertificate } from './canonicalize';
import { createOmissionCertificate } from './omission';
import type { SampleBuilder, SampleBuilderOptions, SampleSequence, SegmentKind } from './samples';

export const CURVE_VERSION = 1;
export const CURVE_CORNER_DOT = -0.5;
export const CURVE_SMOOTH_DOT = 0;
export const CURVE_MIN_CHORD_WORLD = 1e-12;
export const CURVE_CHUNK_SPANS = 256;
// Bounds only the VALIDATION of a saved stroke's `fairTol`; the curve no longer reads it (see writeControl).
export const FAIRING_CONTROL_ERROR_DEVICE_PX = 0.25;
// Product-design cap, NOT a main parity witness. M-INK-ZOOM-CAP still needs a current-app run.
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
    // Immutable canonical sample snapshot; finalized ranges are lazy geometry, not a permanent
    // expanded cubic table. The renderer materializes ONLY visible ranges under its byte budget.
    samples: SampleSequence;
    finalizedSpanCount: number;
    replaceableTail: CurveGeometry;
    endpointX: number; endpointY: number;
    packingErrorWorld: number;
}>;

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

// Every freehand span is a cubic through its two samples whose end tangents are shared with the
// neighbouring spans, so the stroke is tangent-continuous through each sample at any sample spacing.
// Until this rule the controls were clamped to the saved fairing tolerance (about 0.01 world px), so
// each span was its own chord: measured, a quick loop arrives as 10–12 samples 30–100 px apart and
// was drawn as a decagon (the user's "sharp corners on faster strokes"). Dense slow input hid it.
//
// Tangent at a sample: the direction from its previous to its next sample (the chord-weighted sum
// of the two unit chords), so a short jittery neighbour chord cannot swing the tangent of a long
// span. Handle: one third of the span's OWN chord, which is the circular-arc handle to within 3%
// for turns up to 40° per sample (7% at 60°) and can never loop a short span behind a long one.
// Corners: a turn of 120° or more (CURVE_CORNER_DOT) is a real corner, the span leaves along its
// chord (the straight third). Between a 90° turn (CURVE_SMOOTH_DOT) and that, the tangent eases
// from the shared one to the chord, so the picture never jumps as a turn crosses the corner rule
// and a quick zig-zag keeps pointed tips instead of loops.
//
// Bound used by every enclosure (stroke bounds, notebook growth): each control lies EXACTLY one
// third of its span's chord from that span's endpoint, whatever the branch, and a cubic lies in the
// hull of its four controls, so a span never leaves the discs of radius chord/3 around its samples
// (CURVE_CONTROL_REACH, accumulated by `CurveReach` in ink/reach.ts).
//
// The saved fairing tolerance no longer limits the curve. It is still read, validated and written
// as before (geomVersion stays 1), so files open both ways; old saved ink now draws smooth too.

function writeControl(out: Float64Array, offset: number, ax: number, ay: number, bx: number, by: number,
    neighbourX: number, neighbourY: number, hasNeighbour: boolean, isEnd: boolean): boolean {
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    const baseX = isEnd ? bx - dx / 3 : ax + dx / 3;
    const baseY = isEnd ? by - dy / 3 : ay + dy / 3;
    if (!Number.isFinite(baseX) || !Number.isFinite(baseY) || !Number.isFinite(length)) throw new RangeError('Ink control overflow');
    out[offset] = baseX; out[offset + 1] = baseY;
    if (!hasNeighbour || length <= CURVE_MIN_CHORD_WORLD) return length <= CURVE_MIN_CHORD_WORLD;
    // The neighbour chord, oriented along the stroke: into A for the start control, out of B for the end.
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
        // Both are unit vectors less than 120° apart, so the blend cannot vanish; guard rounding anyway.
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

// Writes one span into caller-owned doubles; repeated reconstruction needs no point/vector objects.
export function writeCurveSpan(samples: SampleSequence, index: number, p: CurveParameters,
    output: Float64Array, offset = 0, endpointLimit = samples.count): number {
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
    if (writeControl(output, offset + 2, ax, ay, bx, by,
        before ? samples.x(index - 1) : 0, before ? samples.y(index - 1) : 0, before, false)) flags |= CurveFlag.CornerBefore;
    if (writeControl(output, offset + 4, ax, ay, bx, by,
        after ? samples.x(index + 2) : 0, after ? samples.y(index + 2) : 0, after, true)) flags |= CurveFlag.CornerAfter;
    if (straight || endpointLimit === 2) flags |= CurveFlag.Straight;
    return flags;
}

export function materializeCurveRange(samples: SampleSequence, range: CurveRange, p: CurveParameters): CurveGeometry {
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
        flags[i] = writeCurveSpan(samples, firstSpan + i, p, cubics, offset);
        for (let j = 0; j < 8; j += 2) {
            minX = Math.min(minX, cubics[offset + j]); maxX = Math.max(maxX, cubics[offset + j]);
            minY = Math.min(minY, cubics[offset + j + 1]); maxY = Math.max(maxY, cubics[offset + j + 1]);
            cubics[offset + j] -= originX; cubics[offset + j + 1] -= originY;
        }
    }
    // The control hull conservatively bounds the entire cubic; radius expansion belongs to width.
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
        // Same span parameterization; convex Bernstein weights bound EVERY point, not only vertices.
        for (let j = 0; j < 8; j += 2) {
            bound = Math.max(bound, Math.hypot(original[j] - packed[j], original[j + 1] - packed[j + 1]));
            magnitude = Math.max(magnitude, Math.abs(original[j]), Math.abs(original[j + 1]), Math.abs(packed[j]), Math.abs(packed[j + 1]));
        }
    }
    return bound === 0 ? 0 : bound + 64 * Number.EPSILON * magnitude;
}

export class LocalCurveBuilder {
    readonly samples: AuthoringSamples;
    readonly parameters: CurveParameters;
    private sequence = 0;
    private completed = false;
    constructor(options: SampleBuilderOptions, captureDeviceScale: number,
        fairingToleranceWorld?: number, certificate?: OmissionCertificate) {
        this.parameters = curveParameters(options.declaredMaxScale, fairingToleranceWorld, options.maxDpr ?? 3);
        this.samples = new AuthoringSamples(options, captureDeviceScale, certificate ?? createOmissionCertificate(this.parameters),
            (before, after, first, count) => packingDisplacement(before, after, first, count, this.parameters));
    }
    append(x: number, y: number, pressure: number | undefined, incomingKind: SegmentKind = 'freehand', pins = 0): void {
        if (this.completed) throw new Error('Completed ink cannot be extended by a later release event');
        this.samples.append(x, y, pressure, incomingKind, pins);
    }
    publish(): CurvePublication {
        if (this.completed) throw new Error('Completed ink has already published its final prefix');
        const samples = this.samples.snapshot();
        const packet = this.publication(samples);
        this.samples.markPublished();
        return packet;
    }
    private publication(samples: SampleSequence): CurvePublication {
        if (!samples.count) throw new Error('Empty ink has no geometry publication');
        const spanCount = samples.count - 1;
        const finalizedSpanCount = Math.max(0, spanCount - 3);
        const sequence = ++this.sequence;
        return Object.freeze({
            sequence, phase: 'wet-real', parameters: this.parameters, samples,
            finalizedSpanCount,
            replaceableTail: materializeCurveRange(samples, { firstSpan: finalizedSpanCount, spanCount: spanCount - finalizedSpanCount }, this.parameters),
            endpointX: samples.x(samples.count - 1), endpointY: samples.y(samples.count - 1),
            packingErrorWorld: this.samples.packingErrorWorld,
        });
    }
    finish(): Readonly<{ samples: SampleBuilder; publication: CurvePublication; }> {
        if (this.completed) throw new Error('Ink has already completed');
        // Capture exactly what was displayed. No final fitting or omission runs here.
        const canonical = this.samples.snapshot(), publication = this.publication(canonical);
        const samples = this.samples.finish();
        this.completed = true;
        return Object.freeze({ samples, publication });
    }
}

export type InkRevision = Readonly<{ nodeId: string; nodeRevision: number; gestureSequence: number; }>;
export function chooseInkPhase(wet: InkRevision, readyDry: InkRevision | null): 'wet-real' | 'dry' {
    // The compositor makes this ONE choice for all bands in a frame. Until the exact dry revision is
    // drawable, keep wet real ink; never draw both (dark overlap) or neither (one-frame hole).
    return readyDry && wet.nodeId === readyDry.nodeId && wet.nodeRevision === readyDry.nodeRevision
        && wet.gestureSequence === readyDry.gestureSequence ? 'dry' : 'wet-real';
}
