import type { WidthModel } from '../model/nodes';
import type { CurveGeometry } from './curve';
import { CurveFlag } from './curve';

// architecture/ink.md §7. Shared verbatim boundary: typed arrays are immutable by OWNERSHIP.
// A compositor keeps its generation alive until it has finished; callers never recycle/mutate them.
export type InkRenderPacket = Readonly<{
    geometryKey: string; nodeId: string; nodeRevision: number;
    gestureSequence: number; phase: 'wet-real' | 'prediction' | 'dry';
    localToWorld: readonly [number, number, number, number, number, number]; // Float64
    boundsWorld: Readonly<{ x: number; y: number; w: number; h: number; }>;
    chunks: readonly Readonly<{
        key: string; originX: number; originY: number; // Float64, relative to stroke local space
        boundsLocal: Readonly<{ x: number; y: number; w: number; h: number; }>;
        cubics: Float32Array; // stride 8: x0,y0,c1x,c1y,c2x,c2y,x1,y1, relative to chunk origin
        radii: Float32Array;  // stride 2 per cubic: r0,r1; linear by arc length
        discs: Float32Array;  // stride 3: x,y,r relative to chunk origin; dots/isolated round coverage
        flags: Uint8Array;    // corner/straight/closed-boundary bits; versioned definition
        packingErrorWorld: number;
    }>[];
    widthModel: 'uniform' | 'pressure-linear-v1';
    paintKey: string; // colour, opacity, ordered bands and dash; pen interior fill is inert (R-20)
}>;

export const INK_PACKING_ERROR_DEVICE_PX = 1 / 16;
export const INK_MAX_PACKED_CHUNKS = 65536;
export type InkWidthModel = WidthModel;
export type InkPacketIdentity = Readonly<{
    geometryKey: string; nodeId: string; nodeRevision: number; gestureSequence: number;
    phase: InkRenderPacket['phase'];
    localToWorld: InkRenderPacket['localToWorld'];
    widthModel: InkWidthModel;
    paintKey: string;
    declaredDeviceScale: number;
}>;
export type VisibleInkChunk = Readonly<{
    key: string;
    geometry: CurveGeometry;
    radii: Float64Array; // supplied by the shared width realization, never a second pressure smoother
    discs: Float64Array; // explicit calibrated dots/round coverage; not an inferred width/2 tap
    // R-W9: one-time sample packing at seal shares the frame's 0.1 px movement allowance and this
    // packing allocation. It is not a second independent error budget on top of the final outline.
    sourcePackingErrorWorld: number; // publication.packingErrorWorld for wet real ink; 0 for canonical dry ink
    // If packing needs to subdivide variable-width geometry, width supplies its CANONICAL radius at
    // the original cubic's t, using arc length. Linear interpolation in t is NOT substituted here.
    radiusAt?: (span: number, t: number) => number;
}>;
type PackedChunk = InkRenderPacket['chunks'][number];
type Bounds = { x: number; y: number; w: number; h: number; };

function checkRadius(r: number): void {
    if (!Number.isFinite(r) || r < 0) throw new RangeError('Ink radius must be finite and non-negative');
}
function maxSingularScale(m: InkRenderPacket['localToWorld']): number {
    const norm = Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
    if (!norm) return 0;
    const a = m[0] / norm, b = m[1] / norm, c = m[2] / norm, d = m[3] / norm;
    return norm * Math.sqrt(((a * a + b * b + c * c + d * d)
        + Math.hypot(a * a + b * b - c * c - d * d, 2 * (a * c + b * d))) / 2);
}
function union(a: Bounds | undefined, b: Bounds): Bounds {
    if (!a) return { ...b };
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
function transformBounds(b: Bounds, m: InkRenderPacket['localToWorld']): Bounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const x = b.x + (i & 1 ? b.w : 0), y = b.y + (i & 2 ? b.h : 0);
        const wx = m[0] * x + m[2] * y + m[4], wy = m[1] * x + m[3] * y + m[5];
        if (!Number.isFinite(wx) || !Number.isFinite(wy)) throw new RangeError('Ink world bounds overflow');
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function tryPack(key: string, originX: number, originY: number, cubics: Float64Array, radii: Float64Array,
    discs: Float64Array, flags: Uint8Array, sourceError: number, budget: number): PackedChunk | null {
    const packedCubics = new Float32Array(cubics.length), packedRadii = new Float32Array(radii.length), packedDiscs = new Float32Array(discs.length);
    let centreError = 0, radiusError = 0, discError = 0;
    let magnitude = Math.max(1, Math.abs(originX), Math.abs(originY));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < cubics.length; i += 8) {
        const span = i / 8, r0 = radii[2 * span], r1 = radii[2 * span + 1];
        checkRadius(r0); checkRadius(r1);
        const radius = Math.max(r0, r1);
        for (let j = 0; j < 8; j += 2) {
            const x = cubics[i + j], y = cubics[i + j + 1];
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Non-finite ink control');
            packedCubics[i + j] = x; packedCubics[i + j + 1] = y;
            magnitude = Math.max(magnitude, Math.abs(x), Math.abs(y), radius);
            centreError = Math.max(centreError, Math.hypot(packedCubics[i + j] - x, packedCubics[i + j + 1] - y));
            minX = Math.min(minX, originX + x - radius); maxX = Math.max(maxX, originX + x + radius);
            minY = Math.min(minY, originY + y - radius); maxY = Math.max(maxY, originY + y + radius);
        }
    }
    for (let i = 0; i < radii.length; i++) {
        packedRadii[i] = radii[i];
        radiusError = Math.max(radiusError, Math.abs(packedRadii[i] - radii[i]));
    }
    for (let i = 0; i < discs.length; i += 3) {
        const x = discs[i], y = discs[i + 1], r = discs[i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Non-finite ink disc');
        checkRadius(r);
        packedDiscs[i] = x; packedDiscs[i + 1] = y; packedDiscs[i + 2] = r;
        magnitude = Math.max(magnitude, Math.abs(x), Math.abs(y), r);
        discError = Math.max(discError, Math.hypot(packedDiscs[i] - x, packedDiscs[i + 1] - y) + Math.abs(packedDiscs[i + 2] - r));
        minX = Math.min(minX, originX + x - r); maxX = Math.max(maxX, originX + x + r);
        minY = Math.min(minY, originY + y - r); maxY = Math.max(maxY, originY + y + r);
    }
    // Bernstein weights are non-negative and sum to 1. The largest packed control displacement
    // bounds centreline displacement; Minkowski addition adds radius error (not another .25 px).
    // Conservative Float64 arithmetic allowance also covers adding the anchor back to packed
    // coordinates. Outside the supported coordinate/scale envelope this may refuse, never hide error.
    const arithmeticError = 64 * Number.EPSILON * magnitude;
    const packingErrorWorld = sourceError + arithmeticError + Math.max(centreError + radiusError, discError);
    if (!Number.isFinite(packingErrorWorld) || packingErrorWorld > budget) return null;
    if (minX === Infinity) { minX = maxX = originX; minY = maxY = originY; }
    return Object.freeze({
        key, originX, originY,
        boundsLocal: Object.freeze({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }),
        cubics: packedCubics, radii: packedRadii, discs: packedDiscs, flags: flags.slice(), packingErrorWorld
    });
}

function splitCubic(c: Float64Array): readonly [Float64Array, Float64Array] {
    // de Casteljau at 1/2: affine averages retain the original polynomial exactly in real arithmetic.
    const l = new Float64Array(8), r = new Float64Array(8);
    for (let axis = 0; axis < 2; axis++) {
        const a = c[axis], b = c[axis + 2], d = c[axis + 4], e = c[axis + 6];
        const ab = a / 2 + b / 2, bd = b / 2 + d / 2, de = d / 2 + e / 2;
        const abd = ab / 2 + bd / 2, bde = bd / 2 + de / 2, mid = abd / 2 + bde / 2;
        l[axis] = a; l[axis + 2] = ab; l[axis + 4] = abd; l[axis + 6] = mid;
        r[axis] = mid; r[axis + 2] = bde; r[axis + 4] = de; r[axis + 6] = e;
    }
    return [l, r];
}

function appendPacked(result: PackedChunk[], chunk: PackedChunk): void {
    if (result.length >= INK_MAX_PACKED_CHUNKS) throw new RangeError('Too many visible ink packing chunks');
    result.push(chunk);
}

function packVisibleChunk(source: VisibleInkChunk, budget: number, result: PackedChunk[]): void {
    const g = source.geometry, sourceError = source.sourcePackingErrorWorld;
    if (!Number.isFinite(sourceError) || sourceError < 0 || sourceError > budget) throw new RangeError('Canonical sample packing already exhausts the ink budget');
    if (g.cubics.length !== 8 * g.spanCount || g.flags.length !== g.spanCount || source.radii.length !== 2 * g.spanCount
        || source.discs.length % 3 !== 0) throw new RangeError('Malformed visible ink chunk');
    for (let i = 0; i < g.flags.length; i++) if (g.flags[i] & ~63) throw new RangeError('Unknown v1 ink flag');
    const whole = tryPack(source.key, g.originX, g.originY, g.cubics, source.radii, source.discs, g.flags, sourceError, budget);
    if (whole) { appendPacked(result, whole); return; }
    // A long jump is rebased, not uploaded with an unbounded local Float32 error. Work is bounded;
    // if a malformed/extreme radius cannot fit at any origin, keep canonical ink and report refusal.
    for (let span = 0; span < g.spanCount; span++) {
        const stack: { cubic: Float64Array; r0: number; r1: number; t0: number; t1: number; flags: number; depth: number; }[] = [
            {
                cubic: g.cubics.slice(8 * span, 8 * span + 8), r0: source.radii[2 * span],
                r1: source.radii[2 * span + 1], t0: 0, t1: 1, flags: g.flags[span], depth: 0
            },
        ];
        while (stack.length) {
            const part = stack.pop()!, dx = part.cubic[0], dy = part.cubic[1];
            const rebased = part.cubic.slice();
            for (let j = 0; j < 8; j += 2) { rebased[j] -= dx; rebased[j + 1] -= dy; }
            const key = `${source.key}:${span}:${part.t0}:${part.t1}`;
            let magnitude = Math.max(1, Math.abs(g.originX), Math.abs(g.originY));
            for (let j = 0; j < 8; j++) magnitude = Math.max(magnitude, Math.abs(part.cubic[j]));
            const subdivisionError = 64 * Number.EPSILON * magnitude * (part.depth + 1);
            const packed = tryPack(key, g.originX + dx, g.originY + dy, rebased,
                new Float64Array([part.r0, part.r1]), new Float64Array(0), new Uint8Array([part.flags]), sourceError + subdivisionError, budget);
            if (packed) { appendPacked(result, packed); continue; }
            if (part.depth >= 32 || result.length + stack.length >= INK_MAX_PACKED_CHUNKS) throw new RangeError('Ink packing requires a finer supported scale or sliced realization');
            const middle = (part.t0 + part.t1) / 2;
            let radius: number;
            if (part.r0 === part.r1 && !source.radiusAt) radius = part.r0;
            else if (source.radiusAt) radius = source.radiusAt(span, middle);
            else throw new RangeError('Variable-width subdivision needs the canonical arc-length radius evaluator');
            checkRadius(radius);
            const [left, right] = splitCubic(part.cubic);
            stack.push({
                cubic: right, r0: radius, r1: part.r1, t0: middle, t1: part.t1,
                flags: part.flags & ~(CurveFlag.First | CurveFlag.CornerBefore), depth: part.depth + 1
            });
            stack.push({
                cubic: left, r0: part.r0, r1: radius, t0: part.t0, t1: middle,
                flags: part.flags & ~(CurveFlag.Last | CurveFlag.CornerAfter), depth: part.depth + 1
            });
        }
    }
    for (let i = 0; i < source.discs.length; i += 3) {
        const x = source.discs[i], y = source.discs[i + 1], radius = source.discs[i + 2];
        const packed = tryPack(`${source.key}:disc:${i / 3}`, g.originX + x, g.originY + y,
            new Float64Array(0), new Float64Array(0), new Float64Array([0, 0, radius]), new Uint8Array(0), sourceError, budget);
        if (!packed) throw new RangeError('Ink disc radius cannot fit the declared packing budget');
        appendPacked(result, packed);
    }
}

export function createInkRenderPacket(identity: InkPacketIdentity, visibleChunks: readonly VisibleInkChunk[]): InkRenderPacket {
    const m = identity.localToWorld;
    if (!m.every(Number.isFinite) || !Number.isFinite(identity.declaredDeviceScale) || identity.declaredDeviceScale <= 0
        || !Number.isSafeInteger(identity.nodeRevision) || identity.nodeRevision < 0
        || !Number.isSafeInteger(identity.gestureSequence) || identity.gestureSequence < 0) throw new RangeError('Invalid ink packet identity or scale');
    const model = identity.widthModel;
    if (model.id === 'pressure-linear-v1') {
        checkRadius(model.rMin); checkRadius(model.rMax);
        if (model.rMax < model.rMin) throw new RangeError('Ink pressure radius gain cannot be negative');
    }
    const singularScale = maxSingularScale(m);
    const scale = identity.declaredDeviceScale * singularScale;
    if (!Number.isFinite(scale)) throw new RangeError('Ink transform scale overflows');
    const budget = scale === 0 ? Infinity : INK_PACKING_ERROR_DEVICE_PX / scale;
    const chunks: PackedChunk[] = [];
    let bounds: Bounds | undefined;
    for (const source of visibleChunks) {
        packVisibleChunk(source, budget, chunks);
        if (chunks.length > INK_MAX_PACKED_CHUNKS) throw new RangeError('Too many visible ink packing chunks');
    }
    for (const chunk of chunks) bounds = union(bounds, transformBounds(chunk.boundsLocal, m));
    // Error was certified in stroke-local units. The packet advertises WORLD error even during a
    // non-rigid preview; the largest singular scale is conservative for every displacement direction.
    const worldChunks = chunks.map(chunk => {
        const packingErrorWorld = chunk.packingErrorWorld * singularScale;
        if (!Number.isFinite(packingErrorWorld)) throw new RangeError('Ink world packing error overflows');
        return Object.freeze({ ...chunk, packingErrorWorld });
    });
    // Copy the tuple as well: a caller changing a preview matrix cannot mutate an earlier generation.
    const localToWorld = Object.freeze([...m]) as InkRenderPacket['localToWorld'];
    return Object.freeze({
        geometryKey: identity.geometryKey, nodeId: identity.nodeId, nodeRevision: identity.nodeRevision,
        gestureSequence: identity.gestureSequence, phase: identity.phase, localToWorld,
        boundsWorld: Object.freeze(bounds ?? { x: m[4], y: m[5], w: 0, h: 0 }), chunks: Object.freeze(worldChunks),
        widthModel: model.id, paintKey: identity.paintKey
    });
}
