import type { PathCommand } from '../../platform/types';
import type { CurveGeometry } from './curve';
import { CurveFlag } from './curve';
import { CubicFlattenJob, INK_CAP_ERROR_DEVICE_PX, INK_CENTRELINE_ERROR_DEVICE_PX, INK_MAX_FLAT_PIECES, INK_RADIUS_ERROR_DEVICE_PX } from './flatten';
import type { CubicArcMap } from './flatten';
import type { SampleSequence } from './samples';
import { curveRadii, DOT_METRIC_PROVISIONAL, interpolateRadius, radiusAtCurveParameter, radiusAtSample, strokeDot } from './width';
import type { DotMetric, InkDot, InkWidth } from './width';

export interface DashPattern {
    readonly lengths: readonly number[]; // Positive even-count on/off lengths in world units; no guessed recipe.
    readonly phase: number;
}
export interface ArcPointMotifs {
    readonly spacing: number; // Exact round dots at these arc positions, NOT short on-intervals.
    readonly phase: number;
}
export interface CoverageOptions {
    readonly deviceScale: number;
    readonly closed?: boolean;
    readonly dotMetric?: DotMetric;
    readonly dot?: InkDot | null; // Cached WHOLE-stroke classification, mandatory for partial chunks.
    readonly dash?: DashPattern;
    readonly pointMotifs?: ArcPointMotifs;
    readonly arcPrefix?: Readonly<{ distanceWorld: number; errorWorld: number; }>;
    readonly radiusSlopeBound?: number; // Whole-stroke bound required for partial pressure/dash chunks.
    readonly maxPrimitives?: number;
}
export interface InkCoverage {
    readonly geometry: CurveGeometry;
    readonly radii: Float64Array;
    readonly arcMaps: readonly CubicArcMap[];
    readonly segments: Float64Array; // stride 6: x0,y0,r0,x1,y1,r1; endpoint-disc convex hulls.
    readonly discs: Float64Array; // stride 3: x,y,r; explicit taps and round point motifs.
    readonly centreline: Float64Array; // stride 4, undashed canonical centreline approximation.
    readonly boundsLocal: Readonly<{ x: number; y: number; w: number; h: number; }>;
    readonly centrelineBoundsLocal: Readonly<{ x: number; y: number; w: number; h: number; }>;
    readonly centreErrorWorld: number;
    readonly radiusErrorWorld: number;
    readonly dashPhaseErrorWorld: number;
    readonly lengthWorld: number; // Arc-coordinate estimate to carry into the next chunk's prefix.
    readonly lengthLowerWorld: number;
    readonly lengthUpperWorld: number;
    readonly closed: boolean;
    radiusAt(span: number, t: number): number;
}

class Rows {
    data: Float64Array;
    count = 0;
    constructor(readonly stride: number, private readonly limit: number) { this.data = new Float64Array(16 * stride); }
    reserve(): number {
        if (this.count >= this.limit) throw new RangeError('Ink coverage exceeds its primitive ceiling; canonical samples remain intact');
        if ((this.count + 1) * this.stride > this.data.length) {
            const larger = new Float64Array(Math.min(this.limit, this.count * 2) * this.stride);
            larger.set(this.data); this.data = larger;
        }
        return this.stride * this.count++;
    }
    finish(): Float64Array {
        const result = this.data.slice(0, this.count * this.stride);
        this.data = new Float64Array(0);
        return result;
    }
}
class DashCursor {
    index = 0;
    remaining = 0;
    readonly lengths: readonly number[];
    constructor(pattern: DashPattern, distance: number) {
        const lengths = pattern.lengths.slice();
        if (!lengths.length || lengths.length % 2 || lengths.length > 128 || !Number.isFinite(pattern.phase)
            || lengths.some(x => !Number.isFinite(x) || x <= 0)) throw new RangeError('Invalid world-unit ink dash pattern');
        const period = lengths.reduce((a, b) => a + b, 0);
        if (!Number.isFinite(period) || period <= 0) throw new RangeError('Ink dash period must be positive');
        this.lengths = Object.freeze(lengths);
        const shifted = distance + pattern.phase;
        if (!Number.isFinite(shifted)) throw new RangeError('Ink dash phase overflows');
        let phase = ((shifted % period) + period) % period;
        for (let i = 0; i < lengths.length; i++) {
            if (phase < lengths[i]) { this.index = i; this.remaining = lengths[i] - phase; return; }
            phase -= lengths[i];
        }
        this.remaining = lengths[0];
    }
    advance(): void { this.index = (this.index + 1) % this.lengths.length; this.remaining = this.lengths[this.index]; }
}

function closeGeometry(samples: SampleSequence, g: CurveGeometry, closed: boolean): CurveGeometry {
    if (!closed || samples.count < 2 || g.firstSpan + g.spanCount !== samples.count - 1) return g;
    const ax = samples.x(samples.count - 1) - g.originX, ay = samples.y(samples.count - 1) - g.originY;
    const bx = samples.x(0) - g.originX, by = samples.y(0) - g.originY;
    const c = new Float64Array(g.cubics.length + 8), f = new Uint8Array(g.flags.length + 1), i = g.cubics.length;
    c.set(g.cubics); f.set(g.flags);
    c[i] = ax; c[i + 1] = ay; c[i + 2] = ax + (bx - ax) / 3; c[i + 3] = ay + (by - ay) / 3;
    c[i + 4] = bx - (bx - ax) / 3; c[i + 5] = by - (by - ay) / 3; c[i + 6] = bx; c[i + 7] = by;
    if (f.length > 1) f[f.length - 2] &= ~CurveFlag.Last;
    f[f.length - 1] = CurveFlag.Straight | CurveFlag.Closure | CurveFlag.Last;
    const x = Math.min(g.boundsLocal.x, samples.x(0)), y = Math.min(g.boundsLocal.y, samples.y(0));
    return Object.freeze({
        ...g, cubics: c, flags: f, spanCount: g.spanCount + 1,
        boundsLocal: Object.freeze({
            x, y, w: Math.max(g.boundsLocal.x + g.boundsLocal.w, samples.x(0)) - x,
            h: Math.max(g.boundsLocal.y + g.boundsLocal.h, samples.y(0)) - y
        })
    });
}

export class InkCoverageJob {
    private readonly geometry: CurveGeometry;
    private readonly radii: Float64Array;
    private readonly maps: CubicArcMap[] = [];
    private readonly segments: Rows;
    private readonly discs: Rows;
    private readonly centreline: Rows;
    private readonly dash: DashCursor | undefined;
    private readonly pointSpacing: number;
    private nextPoint = 0;
    private arcPosition = 0;
    private isDot = false;
    private readonly patterned: boolean;
    private readonly centreTolerance: number;
    private readonly radiusTolerance: number;
    private readonly arcTolerance: number;
    private readonly prefixError: number;
    private readonly originError: number;
    private readonly radiusSlope: number;
    private readonly radiusArithmetic: number;
    private readonly reachesEnd: boolean;
    private active: CubicFlattenJob | undefined;
    private map: CubicArcMap | undefined;
    private span = 0;
    private row = 0;
    private progress = 0;
    private leafStarted = false;
    private lengthLower = 0;
    private lengthUpper = 0;
    private centreError = 0;
    private radiusError = 0;
    private resultValue: InkCoverage | undefined;
    private cancelled = false;
    private failure: unknown;
    private readonly closed: boolean;
    constructor(samples: SampleSequence, source: CurveGeometry, style: InkWidth, options: CoverageOptions) {
        if (!Number.isFinite(options.deviceScale) || options.deviceScale <= 0) throw new RangeError('Invalid ink realization scale');
        this.closed = options.closed ?? false;
        this.patterned = !!(options.dash || options.pointMotifs);
        if (options.dash && options.pointMotifs) throw new RangeError('Choose half-open dash intervals OR explicit point motifs');
        this.reachesEnd = source.firstSpan + source.spanCount === samples.count - 1;
        this.geometry = closeGeometry(samples, source, this.closed);
        const originalRadii = curveRadii(samples, source, style);
        this.radii = new Float64Array(2 * this.geometry.spanCount); this.radii.set(originalRadii);
        if (this.geometry !== source) {
            this.radii[this.radii.length - 2] = radiusAtSample(samples, samples.count - 1, style);
            this.radii[this.radii.length - 1] = radiusAtSample(samples, 0, style);
        }
        const limit = options.maxPrimitives ?? INK_MAX_FLAT_PIECES;
        if (!Number.isInteger(limit) || limit <= 0 || limit > INK_MAX_FLAT_PIECES) throw new RangeError('Invalid coverage primitive ceiling');
        this.segments = new Rows(6, limit); this.discs = new Rows(3, limit); this.centreline = new Rows(4, limit);
        this.centreTolerance = INK_CENTRELINE_ERROR_DEVICE_PX / options.deviceScale / 2;
        this.radiusTolerance = INK_RADIUS_ERROR_DEVICE_PX / options.deviceScale;
        let magnitude = Math.max(1, Math.abs(this.geometry.originX), Math.abs(this.geometry.originY));
        for (const value of this.geometry.cubics) magnitude = Math.max(magnitude, Math.abs(value));
        this.originError = 64 * Number.EPSILON * magnitude;
        if (!Number.isFinite(this.originError) || this.originError >= this.centreTolerance) throw new RangeError('Ink coordinates cannot meet this device-scale tolerance');
        let localSlope = 0, maximumRadius = 0;
        for (const radius of this.radii) maximumRadius = Math.max(maximumRadius, radius);
        this.radiusArithmetic = 64 * Number.EPSILON * maximumRadius;
        if (!Number.isFinite(this.radiusArithmetic) || this.radiusArithmetic >= this.radiusTolerance / 2) throw new RangeError('Ink radius cannot meet this device-scale tolerance');
        for (let i = 0; i < this.geometry.spanCount; i++) {
            const c = this.geometry.cubics, offset = 8 * i;
            const chord = Math.hypot(c[offset + 6] - c[offset], c[offset + 7] - c[offset + 1]);
            const chordLower = Math.max(0, chord * (1 - 16 * Number.EPSILON) - 16 * Number.MIN_VALUE);
            if (chordLower) localSlope = Math.max(localSlope, Math.abs(this.radii[2 * i + 1] - this.radii[2 * i]) / chordLower);
        }
        this.radiusSlope = options.radiusSlopeBound ?? localSlope;
        if (!Number.isFinite(this.radiusSlope) || this.radiusSlope < localSlope || (this.patterned && style.model.id !== 'uniform'
            && (source.firstSpan > 0 || !this.reachesEnd) && options.radiusSlopeBound === undefined)) {
            throw new RangeError('Partial pressure/dash geometry needs a certified whole-stroke radius-slope bound');
        }
        const phaseBudget = Math.min(this.centreTolerance / 2, this.radiusSlope ? this.radiusTolerance / (4 * this.radiusSlope) : Infinity);
        this.arcTolerance = this.patterned ? phaseBudget / Math.max(1, samples.count - 1 + (this.closed ? 1 : 0)) : Infinity;
        this.prefixError = options.arcPrefix?.errorWorld ?? 0;
        const distance = options.arcPrefix?.distanceWorld ?? 0;
        if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(this.prefixError) || this.prefixError < 0
            || this.prefixError > phaseBudget || (this.patterned && source.firstSpan > 0 && !options.arcPrefix)) {
            throw new RangeError('Dashed chunks need a certified whole-stroke arc-length prefix');
        }
        this.dash = options.dash ? new DashCursor(options.dash, distance) : undefined;
        this.pointSpacing = options.pointMotifs?.spacing ?? 0;
        if (options.pointMotifs) {
            if (!Number.isFinite(this.pointSpacing) || this.pointSpacing <= 0 || !Number.isFinite(options.pointMotifs.phase)) throw new RangeError('Invalid world-unit point-motif pattern');
            const shifted = distance + options.pointMotifs.phase;
            if (!Number.isFinite(shifted)) throw new RangeError('Ink point-motif phase overflows');
            const phase = ((shifted % this.pointSpacing) + this.pointSpacing) % this.pointSpacing;
            this.nextPoint = phase === 0 ? 0 : this.pointSpacing - phase;
        }
        if (options.dot === undefined && (source.firstSpan > 0 || !this.reachesEnd)) {
            throw new RangeError('Partial ink chunks need the cached whole-stroke dot classification');
        }
        const dot = options.dot === undefined ? strokeDot(samples, style, options.dotMetric ?? DOT_METRIC_PROVISIONAL) : options.dot;
        if (dot) {
            this.isDot = true;
            this.disc(dot.x, dot.y, dot.radius);
            const i = this.centreline.reserve(), data = this.centreline.data;
            data[i] = data[i + 2] = dot.x; data[i + 1] = data[i + 3] = dot.y;
            this.span = this.geometry.spanCount;
        }
    }
    get result(): InkCoverage {
        if (!this.resultValue) throw new Error('Ink coverage is not complete');
        return this.resultValue;
    }
    cancel(): void { this.cancelled = true; this.active?.cancel(); }
    step(maxWork: number): 'pending' | 'complete' | 'cancelled' {
        if (this.failure) throw this.failure;
        try { return this.advance(maxWork); }
        catch (error) {
            this.failure = error;
            this.active?.cancel();
            this.segments.data = new Float64Array(0); this.discs.data = new Float64Array(0); this.centreline.data = new Float64Array(0);
            throw error;
        }
    }
    private advance(maxWork: number): 'pending' | 'complete' | 'cancelled' {
        if (this.cancelled) return 'cancelled';
        if (this.resultValue) return 'complete';
        if (!Number.isInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid ink work slice');
        for (let work = 0; work < maxWork; work++) {
            if (this.map) {
                if (this.row < this.map.pieces.length / 9) { this.emitLeaf(); continue; }
                this.maps.push(this.map);
                const lower = this.lengthLower + this.map.lowerLength, upper = this.lengthUpper + this.map.upperLength;
                const rounding = 4 * Number.EPSILON * Math.max(lower, upper);
                this.lengthLower = Math.max(this.lengthLower, lower - rounding); this.lengthUpper = upper + rounding;
                this.centreError = Math.max(this.centreError, this.map.centreErrorWorld + this.originError);
                this.radiusError = Math.max(this.radiusError, Math.abs(this.radii[2 * this.span + 1] - this.radii[2 * this.span]) * this.map.radiusFractionError);
                this.map = undefined; this.active = undefined; this.span++;
            }
            if (this.span >= this.geometry.spanCount) { this.complete(); return 'complete'; }
            if (!this.active) {
                this.active = new CubicFlattenJob(this.geometry.cubics.slice(8 * this.span, 8 * this.span + 8), {
                    centreToleranceWorld: this.centreTolerance - this.originError, radiusToleranceWorld: this.radiusTolerance / 2 - this.radiusArithmetic,
                    radiusChange: Math.abs(this.radii[2 * this.span + 1] - this.radii[2 * this.span]), arcToleranceWorld: this.arcTolerance,
                });
            }
            if (this.active.step(1) === 'complete') { this.map = this.active.result; this.row = 0; this.progress = 0; this.leafStarted = false; }
        }
        return 'pending';
    }
    private disc(x: number, y: number, radius: number): void {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius < 0) throw new RangeError('Non-finite ink disc');
        const i = this.discs.reserve(), a = this.discs.data;
        a[i] = x; a[i + 1] = y; a[i + 2] = radius;
    }
    private emitLeaf(): void {
        const map = this.map!, offset = 9 * this.row, p = map.pieces, g = this.geometry;
        const ax = g.originX + p[offset + 2], ay = g.originY + p[offset + 3];
        const bx = g.originX + p[offset + 4], by = g.originY + p[offset + 5], length = p[offset + 7];
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) throw new RangeError('Ink coverage coordinates overflow');
        const r0 = this.radii[2 * this.span], r1 = this.radii[2 * this.span + 1];
        const start = map.length ? p[offset + 6] / map.length : 0;
        const end = map.length ? (p[offset + 6] + length) / map.length : 1;
        if (!this.leafStarted) {
            const i = this.centreline.reserve(), a = this.centreline.data;
            a[i] = ax; a[i + 1] = ay; a[i + 2] = bx; a[i + 3] = by; this.leafStarted = true;
        }
        const dash = this.dash;
        if (this.pointSpacing) {
            // Point motifs at a shared arc boundary belong to the following leaf. Skipping zero
            // spans before emitting uses the same R-W24 right-continuous radius as ordinary dashes.
            if (map.upperLength === 0 || this.nextPoint >= this.arcPosition + length) {
                this.arcPosition += length; this.row++; this.leafStarted = false; return;
            }
            const t = length ? Math.max(0, Math.min(1, (this.nextPoint - this.arcPosition) / length)) : 0;
            this.disc(ax + (bx - ax) * t, ay + (by - ay) * t, interpolateRadius(r0, r1, start + (end - start) * t));
            const next = this.nextPoint + this.pointSpacing;
            if (next === this.nextPoint) throw new RangeError('Point-motif spacing loses arc-position precision');
            this.nextPoint = next; return;
        }
        if (dash && dash.remaining === 0) { dash.advance(); return; }
        // R-W24: dash intervals are half-open [start,end). At coincident samples the radius is
        // right-continuous (LATER sample wins). A dash ending there keeps its earlier left-limit
        // cap: advance the cursor above BEFORE considering a zero-length span. Intermediate zero
        // spans add no separate disc; the following moving span starts at the final later radius.
        if (dash && map.upperLength === 0) {
            if (!(dash.index & 1) && this.reachesEnd && !this.closed && this.span + 1 === g.spanCount) this.disc(bx, by, r1);
            this.row++; this.progress = 0; this.leafStarted = false; return;
        }
        const amount = dash ? Math.min(length - this.progress, dash.remaining) : length;
        const a = length ? this.progress / length : 0, b = length ? (this.progress + amount) / length : 1;
        if (!dash || !(dash.index & 1)) {
            const i = this.segments.reserve(), out = this.segments.data;
            out[i] = ax + (bx - ax) * a; out[i + 1] = ay + (by - ay) * a;
            out[i + 2] = interpolateRadius(r0, r1, start + (end - start) * a);
            out[i + 3] = ax + (bx - ax) * b; out[i + 4] = ay + (by - ay) * b;
            out[i + 5] = interpolateRadius(r0, r1, start + (end - start) * b);
        }
        this.progress += amount;
        if (dash) dash.remaining = Math.max(0, dash.remaining - amount);
        if (this.progress >= length) { this.arcPosition += length; this.row++; this.progress = 0; this.leafStarted = false; }
    }
    private complete(): void {
        const phaseError = this.patterned ? this.prefixError
            + Math.max(Math.abs(this.arcPosition - this.lengthLower), Math.abs(this.lengthUpper - this.arcPosition)) : 0;
        const radiusError = this.radiusError + this.radiusArithmetic + this.radiusSlope * phaseError;
        if (radiusError > this.radiusTolerance || this.centreError + phaseError > 2 * this.centreTolerance) {
            throw new RangeError('Ink arc-length bounds exceed the declared geometry allocation');
        }
        if (this.pointSpacing && !this.isDot && this.reachesEnd && this.nextPoint === this.arcPosition && this.geometry.spanCount) {
            const g = this.geometry, n = g.cubics.length;
            this.disc(g.originX + g.cubics[n - 2], g.originY + g.cubics[n - 1], this.radii[this.radii.length - 1]);
        }
        const segments = this.segments.finish(), discs = this.discs.finish(), centreline = this.centreline.finish();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < segments.length; i += 3) {
            const x = segments[i], y = segments[i + 1], r = segments[i + 2];
            minX = Math.min(minX, x - r); minY = Math.min(minY, y - r); maxX = Math.max(maxX, x + r); maxY = Math.max(maxY, y + r);
        }
        for (let i = 0; i < discs.length; i += 3) {
            const x = discs[i], y = discs[i + 1], r = discs[i + 2];
            minX = Math.min(minX, x - r); minY = Math.min(minY, y - r); maxX = Math.max(maxX, x + r); maxY = Math.max(maxY, y + r);
        }
        if (minX === Infinity) { minX = maxX = this.geometry.originX; minY = maxY = this.geometry.originY; }
        let centreMinX = Infinity, centreMinY = Infinity, centreMaxX = -Infinity, centreMaxY = -Infinity;
        for (let i = 0; i < centreline.length; i += 2) {
            centreMinX = Math.min(centreMinX, centreline[i]); centreMaxX = Math.max(centreMaxX, centreline[i]);
            centreMinY = Math.min(centreMinY, centreline[i + 1]); centreMaxY = Math.max(centreMaxY, centreline[i + 1]);
        }
        if (centreMinX === Infinity) { centreMinX = centreMaxX = this.geometry.originX; centreMinY = centreMaxY = this.geometry.originY; }
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX - minX) || !Number.isFinite(maxY - minY)
            || !Number.isFinite(centreMinX) || !Number.isFinite(centreMinY) || !Number.isFinite(centreMaxX - centreMinX) || !Number.isFinite(centreMaxY - centreMinY)) {
            throw new RangeError('Ink coverage bounds overflow');
        }
        const maps = Object.freeze(this.maps), radii = this.radii, patterned = this.patterned;
        const paintError = this.centreError + radiusError + phaseError;
        const boundsLocal = Object.freeze({
            x: minX - paintError, y: minY - paintError,
            w: maxX - minX + 2 * paintError, h: maxY - minY + 2 * paintError
        });
        const centrelineBoundsLocal = Object.freeze({
            x: centreMinX - this.centreError, y: centreMinY - this.centreError,
            w: centreMaxX - centreMinX + 2 * this.centreError, h: centreMaxY - centreMinY + 2 * this.centreError
        });
        if (!Object.values(boundsLocal).every(Number.isFinite) || !Object.values(centrelineBoundsLocal).every(Number.isFinite)) {
            throw new RangeError('Ink conservative bounds overflow');
        }
        this.resultValue = Object.freeze({
            geometry: this.geometry, radii, arcMaps: maps, segments, discs, centreline, boundsLocal, centrelineBoundsLocal,
            centreErrorWorld: this.centreError, radiusErrorWorld: radiusError,
            dashPhaseErrorWorld: phaseError,
            lengthWorld: this.arcPosition, lengthLowerWorld: this.lengthLower, lengthUpperWorld: this.lengthUpper, closed: this.closed,
            radiusAt: (span: number, t: number) => {
                if (!Number.isInteger(span) || span < 0 || span >= maps.length || !Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('Invalid ink radius span or parameter');
                if (patterned && maps[span].upperLength === 0) return radii[2 * span + 1];
                return radiusAtCurveParameter(maps[span], radii[2 * span], radii[2 * span + 1], t);
            },
        });
    }
}

// ink.md §6.1: conv(D(a,r0),D(b,r1)) = union_t D((1-t)a+tb,(1-t)r0+tr1).
// Reference for the offset viewpoint only: CGAL 2D Minkowski Sums manual, "Offsetting a Polygon".
// Tangent normals below follow directly from n·(b-a)=r0-r1; no library code/boolean union.
export const INK_OUTLINE_FILL_RULE = 'nonzero' as const;

// Every subpath below has positive orientation. Fill this ENTIRE path once with nonzero winding;
// never source-over each capsule separately or count overlaps in a wrapping 8-bit GPU winding sum.
export function coverageOutline(coverage: InkCoverage, deviceScale: number, maxCommands = 1048576): readonly PathCommand[] {
    if (!Number.isFinite(deviceScale) || deviceScale <= 0 || !Number.isInteger(maxCommands) || maxCommands <= 0) throw new RangeError('Invalid vector outline budget');
    const output: PathCommand[] = [], tolerance = INK_CAP_ERROR_DEVICE_PX / deviceScale;
    const push = (command: PathCommand) => {
        if (output.length >= maxCommands || command.slice(1).some(x => !Number.isFinite(x))) throw new RangeError('Ink vector outline exceeds its finite command budget');
        output.push(command);
    };
    const arc = (x: number, y: number, radius: number, start: number, sweep: number) => {
        if (!radius || !sweep) return;
        let count = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
        for (; ;) {
            const angle = sweep / count, c = Math.cos(angle / 2), s = Math.sin(angle / 2);
            const d = s * (1 - c) / (2 * (1 + c));
            // For k=4/3*tan(theta/4), rho²-1 = d²*u²*(1-u²)², |u|<=1.
            // max u²(1-u²)²=4/27 and sqrt(1+v)-1<=v/2: radial error <=2*r*d²/27.
            const arithmetic = 128 * Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(y), radius);
            if (2 * radius * d * d / 27 + arithmetic <= tolerance) break;
            count *= 2;
            if (count > maxCommands) throw new RangeError('Ink cap cannot meet the declared scale within its command ceiling');
        }
        const angle = sweep / count, k = 4 / 3 * Math.tan(angle / 4);
        for (let i = 0; i < count; i++) {
            const a = start + i * angle, b = start + (i + 1) * angle;
            push(['C', x + radius * (Math.cos(a) - k * Math.sin(a)), y + radius * (Math.sin(a) + k * Math.cos(a)),
                x + radius * (Math.cos(b) + k * Math.sin(b)), y + radius * (Math.sin(b) - k * Math.cos(b)),
                x + radius * Math.cos(b), y + radius * Math.sin(b)]);
        }
    };
    const disc = (x: number, y: number, radius: number) => {
        if (!radius) return;
        push(['M', x + radius, y]); arc(x, y, radius, 0, 2 * Math.PI); push(['Z']);
    };
    const a = coverage.segments;
    for (let i = 0; i < a.length; i += 6) {
        const ax = a[i], ay = a[i + 1], r0 = a[i + 2], bx = a[i + 3], by = a[i + 4], r1 = a[i + 5];
        const dx = bx - ax, dy = by - ay, distance = Math.hypot(dx, dy), difference = r1 - r0;
        if (distance <= Math.abs(difference)) { if (r0 >= r1) disc(ax, ay, r0); else disc(bx, by, r1); continue; }
        const ux = dx / distance, uy = dy / distance, along = -difference / distance;
        const perpendicular = Math.sqrt(Math.max(0, 1 - along * along));
        const minusX = along * ux + perpendicular * uy, minusY = along * uy - perpendicular * ux;
        const plusX = along * ux - perpendicular * uy, plusY = along * uy + perpendicular * ux;
        const start = Math.atan2(minusY, minusX), sweep = 2 * Math.acos(along);
        push(['M', ax + r0 * minusX, ay + r0 * minusY]);
        push(['L', bx + r1 * minusX, by + r1 * minusY]);
        arc(bx, by, r1, start, sweep);
        push(['L', ax + r0 * plusX, ay + r0 * plusY]);
        arc(ax, ay, r0, start + sweep, 2 * Math.PI - sweep); push(['Z']);
    }
    for (let i = 0; i < coverage.discs.length; i += 3) disc(coverage.discs[i], coverage.discs[i + 1], coverage.discs[i + 2]);
    return Object.freeze(output);
}
