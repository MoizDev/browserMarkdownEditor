// D-13, ink.md §5–6. Mathematical references: M. Breuß, Numerical Algorithms for Visual
// Computing I (2008), §5.3, Theorem 7 (convex hull/de Casteljau); J. Gravesen, "The Length
// of Bézier Curves", Graphics Gems IV, IV.7 (chord/control-polygon length bounds).
// This is an independent derivation/implementation, not code from that collection or a library.
export const INK_CENTRELINE_ERROR_DEVICE_PX = 1 / 16;
export const INK_RADIUS_ERROR_DEVICE_PX = 1 / 16;
export const INK_CAP_ERROR_DEVICE_PX = 1 / 16;
export const INK_MAX_FLAT_PIECES = 262144;
export const INK_MAX_FLAT_DEPTH = 32;
export interface CubicArcMap {
    readonly cubic: Float64Array;
    // stride 9: t0,t1,x0,y0,x1,y1,prefixChordLength,chordLength,controlPolygonUpperLength.
    readonly pieces: Float64Array;
    readonly length: number; // Chosen polyline arc coordinate, distinct from its enclosure below.
    readonly lowerLength: number;
    readonly upperLength: number;
    readonly centreErrorWorld: number;
    readonly radiusFractionError: number;
}
export interface FlattenOptions {
    readonly centreToleranceWorld: number;
    readonly radiusToleranceWorld: number;
    readonly radiusChange: number;
    readonly arcToleranceWorld: number; // Infinity when distance-along-curve paint is not used.
    readonly maxPieces?: number;
}

export function pointSegmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay, square = dx * dx + dy * dy;
    const t = square ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / square)) : 0;
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

export class CubicFlattenJob {
    private readonly original: Float64Array;
    private readonly stack = new Float64Array(12 * (INK_MAX_FLAT_DEPTH + 2));
    private readonly current = new Float64Array(8);
    private pending = 1;
    private rows = new Float64Array(9 * 16);
    private count = 0;
    private length = 0;
    private lower = 0;
    private upper = 0;
    private error = 0;
    private output: CubicArcMap | undefined;
    private cancelled = false;
    private failure: unknown;
    private readonly limit: number;
    private readonly options: FlattenOptions;
    constructor(cubic: Float64Array, options: FlattenOptions) {
        this.options = Object.freeze({ ...options });
        if (cubic.length !== 8 || !cubic.every(Number.isFinite)
            || !Number.isFinite(options.centreToleranceWorld) || options.centreToleranceWorld <= 0
            || !Number.isFinite(options.radiusToleranceWorld) || options.radiusToleranceWorld <= 0
            || !Number.isFinite(options.radiusChange) || options.radiusChange < 0
            || !(options.arcToleranceWorld > 0)) throw new RangeError('Invalid ink flattening budget');
        this.original = cubic.slice();
        this.stack.set(cubic);
        this.stack[8] = 0; this.stack[9] = 1;
        this.limit = options.maxPieces ?? INK_MAX_FLAT_PIECES;
        if (!Number.isInteger(this.limit) || this.limit <= 0 || this.limit > INK_MAX_FLAT_PIECES) throw new RangeError('Invalid ink piece ceiling');
    }
    cancel(): void { this.cancelled = true; this.pending = 0; this.rows = new Float64Array(0); }
    get result(): CubicArcMap {
        if (!this.output) throw new Error('Ink flattening has not completed');
        return this.output;
    }
    step(maxWork: number): 'pending' | 'complete' | 'cancelled' {
        if (this.failure) throw this.failure;
        try { return this.advance(maxWork); }
        catch (error) { this.failure = error; this.pending = 0; this.rows = new Float64Array(0); throw error; }
    }
    private advance(maxWork: number): 'pending' | 'complete' | 'cancelled' {
        if (this.cancelled) return 'cancelled';
        if (this.output) return 'complete';
        if (!Number.isInteger(maxWork) || maxWork <= 0) throw new RangeError('Invalid geometry work slice');
        const ratio = this.options.radiusChange ? this.options.radiusToleranceWorld / this.options.radiusChange / 2 : Infinity;
        for (let work = 0; work < maxWork && this.pending; work++) {
            const offset = 12 * --this.pending, c = this.current;
            for (let j = 0; j < 8; j++) c[j] = this.stack[offset + j];
            const t0 = this.stack[offset + 8], t1 = this.stack[offset + 9], depth = this.stack[offset + 10];
            let magnitude = 1, identical = true;
            for (let j = 0; j < 8; j += 2) {
                magnitude = Math.max(magnitude, Math.abs(c[j]), Math.abs(c[j + 1]));
                identical &&= c[j] === c[0] && c[j + 1] === c[1];
            }
            const numeric = this.stack[offset + 11] + (identical ? 0 : 64 * Number.EPSILON * magnitude);
            const chord = Math.hypot(c[6] - c[0], c[7] - c[1]);
            const polygon = Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[4] - c[2], c[5] - c[3]) + Math.hypot(c[6] - c[4], c[7] - c[5]);
            if (!Number.isFinite(chord) || !Number.isFinite(polygon) || !Number.isFinite(numeric)) throw new RangeError('Ink arc-length enclosure overflows');
            const lower = Math.max(0, chord - 4 * numeric), upper = polygon + 16 * numeric;
            const gap = Math.max(0, upper - lower);
            const flat = Math.max(pointSegmentDistance(c[2], c[3], c[0], c[1], c[6], c[7]),
                pointSegmentDistance(c[4], c[5], c[0], c[1], c[6], c[7])) + numeric;
            // The finite segment's error tube is convex, so enclosing ALL controls encloses the
            // whole curve. Continuity of chord projection gives the reverse directed bound too,
            // including cusps/backtracking; distance to the infinite chord line is insufficient.
            const radiusFits = !this.options.radiusChange || (upper === 0 || gap <= ratio * lower);
            const arcFits = this.options.arcToleranceWorld === Infinity || gap <= this.options.arcToleranceWorld * (t1 - t0);
            if (flat <= this.options.centreToleranceWorld && radiusFits && arcFits) {
                this.append(t0, t1, c, chord, lower, upper);
                this.error = Math.max(this.error, flat);
            } else {
                if (depth >= INK_MAX_FLAT_DEPTH) throw new RangeError('Ink flattening cannot certify this scale within its depth ceiling');
                this.split(c, t0, t1, depth, numeric);
            }
        }
        if (this.pending) return 'pending';
        this.output = Object.freeze({
            cubic: this.original, pieces: this.rows.slice(0, 9 * this.count),
            length: this.length, lowerLength: this.lower, upperLength: this.upper, centreErrorWorld: this.error,
            radiusFractionError: this.lower ? 2 * Math.max(0, this.upper - this.lower) / this.lower : 0
        });
        return 'complete';
    }
    private append(t0: number, t1: number, c: Float64Array, chord: number, lower: number, upper: number): void {
        if (this.count >= this.limit) throw new RangeError('Ink flattening exceeded its piece ceiling; canonical samples remain intact');
        if (9 * (this.count + 1) > this.rows.length) {
            const larger = new Float64Array(Math.min(this.limit, this.rows.length / 9 * 2) * 9);
            larger.set(this.rows); this.rows = larger;
        }
        const i = 9 * this.count++;
        this.rows[i] = t0; this.rows[i + 1] = t1;
        this.rows[i + 2] = c[0]; this.rows[i + 3] = c[1]; this.rows[i + 4] = c[6]; this.rows[i + 5] = c[7];
        this.rows[i + 6] = this.length; this.rows[i + 7] = chord; this.rows[i + 8] = upper;
        this.length += chord;
        const lowerSum = this.lower + lower, upperSum = this.upper + upper;
        const rounding = 4 * Number.EPSILON * Math.max(lowerSum, upperSum);
        this.lower = Math.max(this.lower, lowerSum - rounding); this.upper = upperSum + rounding;
        if (!Number.isFinite(this.length) || !Number.isFinite(this.upper)) throw new RangeError('Ink arc-length accumulation overflows');
    }
    private split(c: Float64Array, t0: number, t1: number, depth: number, inheritedError: number): void {
        const right = 12 * this.pending++, left = 12 * this.pending++;
        for (let axis = 0; axis < 2; axis++) {
            const a = c[axis], b = c[axis + 2], d = c[axis + 4], e = c[axis + 6];
            const ab = a / 2 + b / 2, bd = b / 2 + d / 2, de = d / 2 + e / 2;
            const abd = ab / 2 + bd / 2, bde = bd / 2 + de / 2, mid = abd / 2 + bde / 2;
            this.stack[left + axis] = a; this.stack[left + axis + 2] = ab;
            this.stack[left + axis + 4] = abd; this.stack[left + axis + 6] = mid;
            this.stack[right + axis] = mid; this.stack[right + axis + 2] = bde;
            this.stack[right + axis + 4] = de; this.stack[right + axis + 6] = e;
        }
        const mid = (t0 + t1) / 2;
        this.stack[left + 8] = t0; this.stack[left + 9] = mid; this.stack[left + 10] = depth + 1;
        this.stack[right + 8] = mid; this.stack[right + 9] = t1; this.stack[right + 10] = depth + 1;
        this.stack[left + 11] = inheritedError; this.stack[right + 11] = inheritedError;
    }
}
