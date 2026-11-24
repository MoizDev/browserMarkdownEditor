import { styleGeometryMetrics } from '../geom/styleMetrics';
import { CURVE_CHUNK_SPANS, CURVE_VERSION, curveClosure, curveParameters, materializeCurveRange, type CurveParameters, type CurveRange } from '../ink/curve';
import { INK_CAP_ERROR_DEVICE_PX } from '../ink/flatten';
import { InkCoverageJob, coverageOutline, type CoverageOptions, type InkCoverage } from '../ink/outline';
import type { SampleSequence, SegmentKind } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, radiusAtSample, realizeStrokePoints, validateInkWidth, type InkWidth } from '../ink/width';
import type { StrokeNode } from '../model/nodes';
import type { SampleChunk, SampleStoreReader } from '../model/samples';
import { auditCount } from '../../platform/render/renderAudit';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { PathCoverageShapes } from '../../platform/render/pathCoverage';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { pathFillTriangles, type PathFillTriangles } from './pathFillTriangles';
import { inkCoverageChunks, type PaintInkItem } from './paintStream';
import { yieldToHost } from '../../platform/yieldToHost';

// The scene pin owns the sample lease. This adapter borrows chunk views, not a
// point-sized object/array copy, and respects the store's exact chunk endpoints.
function sequence(reader: SampleStoreReader, node: StrokeNode): SampleSequence {
    const count = reader.count(node.samples);
    if (!Number.isSafeInteger(count) || count < 1 || reader.pressureMode(node.samples) !== node.pressure) {
        throw new RangeError('Invalid stroke sample record');
    }
    let cached: SampleChunk | undefined;
    const locate = (i: number): SampleChunk => {
        if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError('Invalid stroke sample index');
        if (!cached || i < cached.first || i >= cached.first + cached.count) cached = reader.read(node.samples, i, count - i).chunk;
        return cached;
    };
    const coordinate = (i: number, axis: 0 | 1): number => {
        const chunk = locate(i), index = i - chunk.first;
        if (index === 0) return axis ? chunk.firstY : chunk.firstX;
        if (index === chunk.count - 1) return axis ? chunk.lastY : chunk.lastX;
        return (axis ? chunk.originY : chunk.originX) + chunk.positions[index * 2 + axis];
    };
    return {
        count,
        x: i => coordinate(i, 0), y: i => coordinate(i, 1),
        pressure: i => {
            const chunk = locate(i), channel = chunk.pressure, offset = i - chunk.first;
            return channel.kind === 'none' ? undefined : channel.kind === 'constant' ? channel.value : channel.values[offset] / 65535;
        },
        segmentKind: i => {
            if (i < 0 || i >= count - 1 || !Number.isInteger(i)) throw new RangeError('Invalid stroke segment index');
            const chunk = locate(i + 1), offset = i + 1 - chunk.first;
            let low = 0, high = chunk.runStarts.length - 1;
            while (low < high) {
                const mid = (low + high + 1) >>> 1;
                if (chunk.runStarts[mid] <= offset) low = mid; else high = mid - 1;
            }
            return (chunk.runKinds[low] ? 'straight' : 'freehand') satisfies SegmentKind;
        },
    };
}

type CoverageWorker = (samples: SampleSequence, parameters: CurveParameters, style: InkWidth,
    range: CurveRange, options: CoverageOptions) => Promise<InkCoverage>;

function* strokeCoverage(node: StrokeNode, samples: SampleStoreReader, options: {
    deviceScale: number; signal?: AbortSignal; worker?: CoverageWorker;
}): Generator<void | Promise<InkCoverage>, readonly InkCoverage[], InkCoverage | undefined> {
    const check = () => options.signal?.throwIfAborted();
    check();
    if (!Number.isFinite(options.deviceScale) || options.deviceScale <= 0 || node.geomVersion !== CURVE_VERSION) {
        throw new RangeError('Unsupported stroke geometry version or device scale');
    }
    if (node.dash === 'none') return Object.freeze([]);
    const points = realizeStrokePoints(sequence(samples, node), node.sx, node.sy);
    const closure = curveClosure(points, node.closed);
    const width: InkWidth = { width: node.width, model: node.widthModel, pressure: node.pressure };
    validateInkWidth(width);
    // Parameter scale is an admission bound, not a transform: the saved tolerance
    // and realized points determine the curve independently of the current camera.
    const parameterScale = node.fairTol > 0 ? Math.min(options.deviceScale, 0.125 / node.fairTol) : options.deviceScale;
    const parameters = curveParameters(parameterScale, node.fairTol, 1);
    let started = performance.now(), work = 0;
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const reset = () => { work = 0; started = performance.now(); };
    const x0 = points.x(0), y0 = points.y(0);
    let dot = true, maxRadius = radiusAtSample(points, 0, width), slope = 0;
    for (let i = 1; i < points.count; i++) {
        if (due()) { yield; check(); reset(); }
        const x = points.x(i), y = points.y(i), radius = radiusAtSample(points, i, width);
        if (x !== x0 || y !== y0) dot = false;
        maxRadius = Math.max(maxRadius, radius);
    }
    const dotValue = dot ? { x: x0, y: y0, radius: DOT_METRIC_PROVISIONAL.radius(node.width, maxRadius, node.widthModel) } : null;
    const metric = node.dash === 'dashed' || node.dash === 'dotted' ? styleGeometryMetrics.dash(node.width) : undefined;
    const pattern: Pick<CoverageOptions, 'dash' | 'pointMotifs'> = node.dash === 'dashed'
        ? { dash: { lengths: metric!.lengths, phase: 0 } }
        : node.dash === 'dotted' ? { pointMotifs: { spacing: metric!.dotSpacing, phase: 0 } } : {};
    const chunks: InkCoverage[] = [];
    let first = 0, distance = 0, error = 0;
    const total = dot ? 0 : points.count - 1;
    // The coverage job certifies partial pressure/dash chunks against the
    // whole stroke; compute its exact local-coordinate chord bound first.
    if (metric && width.model.id !== 'uniform' && !dot) {
        for (let start = 0; start < total; start += CURVE_CHUNK_SPANS) {
            const geometry = materializeCurveRange(points, { firstSpan: start, spanCount: Math.min(CURVE_CHUNK_SPANS, total - start) }, parameters, closure);
            for (let i = 0; i < geometry.spanCount; i++) {
                if (due()) { yield; check(); reset(); }
                const c = geometry.cubics, offset = i * 8;
                const chord = Math.hypot(c[offset + 6] - c[offset], c[offset + 7] - c[offset + 1]);
                const lower = Math.max(0, chord * (1 - 16 * Number.EPSILON) - 16 * Number.MIN_VALUE);
                if (lower) slope = Math.max(slope, Math.abs(radiusAtSample(points, start + i + 1, width) - radiusAtSample(points, start + i, width)) / lower);
            }
        }
    }
    do {
        check();
        const count = Math.min(CURVE_CHUNK_SPANS, total - first);
        const range = { firstSpan: first, spanCount: count };
        const coverageOptions: CoverageOptions = { deviceScale: options.deviceScale, closed: false, closure,
            dot: dotValue, dotMetric: DOT_METRIC_PROVISIONAL, ...pattern,
            ...(metric ? { arcPrefix: { distanceWorld: distance, errorWorld: error }, radiusSlopeBound: slope } : {}) };
        if (options.worker) {
            const coverage = yield options.worker(points, parameters, width, range, coverageOptions);
            if (!coverage) throw new Error('Ink worker returned no coverage');
            chunks.push(coverage);
            distance += coverage.lengthWorld;
            error = coverage.dashPhaseErrorWorld;
        } else {
        const geometry = materializeCurveRange(points, range, parameters, closure);
        const job = new InkCoverageJob(points, geometry, width, coverageOptions);
        try {
            let status: 'pending' | 'complete' | 'cancelled';
            do {
                check();
                status = job.step(1);
                if (status === 'pending' && due()) { yield; check(); reset(); }
            } while (status === 'pending');
            if (status !== 'complete') throw new DOMException('Ink geometry cancelled', 'AbortError');
            const coverage = job.coverage;
            chunks.push(coverage);
            distance += coverage.lengthWorld;
            error = coverage.dashPhaseErrorWorld;
        } finally { job.cancel(); }
        }
        first += count;
        if (first < total) { yield; check(); reset(); }
    } while (first < total);
    check();
    return Object.freeze(chunks);
}

/** A box sure to hold a stroke's ink, from its samples alone (no curve, no outline): their bounds, widened by the widest radius
 * and the longest step between two samples, which bounds how far the fitted curve can leave them. For a stroke whose geometry
 * could not be built (services.ts), so the scene still places it; it is never drawn from. */
export function strokeSampleBounds(node: StrokeNode, samples: SampleStoreReader): [number, number, number, number] {
    const points = realizeStrokePoints(sequence(samples, node), node.sx, node.sy);
    const width: InkWidth = { width: node.width, model: node.widthModel, pressure: node.pressure };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, radius = 0, step = 0;
    for (let i = 0; i < points.count; i++) {
        const x = points.x(i), y = points.y(i);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        radius = Math.max(radius, radiusAtSample(points, i, width));
        if (i) step = Math.max(step, Math.hypot(x - points.x(i - 1), y - points.y(i - 1)));
    }
    if (!(minX <= maxX)) return [0, 0, 0, 0];
    const pad = radius + step;
    return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

/** Chunks are one stroke's union, not independently composited alpha bands. */
export async function buildStrokeCoverage(node: StrokeNode, samples: SampleStoreReader, options: {
    deviceScale: number; cooperate?: () => Promise<void>; signal?: AbortSignal; worker?: CoverageWorker;
}): Promise<readonly InkCoverage[]> {
    const job = strokeCoverage(node, samples, options);
    try {
        let value: InkCoverage | undefined;
        for (;;) {
            options.signal?.throwIfAborted();
            const next = job.next(value);
            if (next.done) return next.value;
            value = next.value ? await next.value : undefined;
            if (!next.value) await (options.cooperate?.() ?? yieldToHost());
            options.signal?.throwIfAborted();
        }
    } finally { job.return(undefined as never); }
}

/** Synchronous capture uses precisely the same geometry and cancellation path. */
export function buildStrokeCoverageNow(node: StrokeNode, samples: SampleStoreReader, options: {
    deviceScale: number; signal?: AbortSignal;
}): readonly InkCoverage[] {
    const job = strokeCoverage(node, samples, options);
    try {
        for (;;) {
            options.signal?.throwIfAborted();
            const next = job.next(undefined);
            if (next.done) return next.value;
        }
    } finally { job.return(undefined as never); }
}

// Tessellated ink for the GPU routes. Geometry is local-space and keyed by the chunk that owns it and by a device-scale
// band, so the device transform is a uniform and a pan or a zoom inside one band builds nothing.

/** Ceilings on the device-px error of an outline: its arcs keep the adapter's 1/16 px (INK_CAP_ERROR_DEVICE_PX), and the flattening
 * keeps the path route's 0.1 px (design §5.1). By reading: a single shared ceiling of 0.1 px loosened every thick stroke's arcs. */
const INK_FLATTEN_DEVICE_PX = 0.1;
/** Geometry error follows the stroke's own thinness. A fixed device-px error is a fixed fraction of a thin stroke: at
 * zoom 0.25 a 1.5 px stroke lost up to 0.16 px per side to the 1/16 px arc tolerance plus the 0.1 px flattening, which
 * the sampling bar never sees (it compares sampling against exact geometry). So the tolerance is this fraction of the
 * chunk's smallest device radius, never above the ceiling, never below the floor (a hairline would cost unbounded vertices). */
const INK_TOLERANCE_RADIUS_FRACTION = 0.01;
const INK_TOLERANCE_FLOOR_PX = 0.005;
/** The thinnest radius, in world units, of an outline's segments and discs (`Infinity` when it has none). The F1 bound is
 * this radius times INK_TOLERANCE_RADIUS_FRACTION, so geometry and the LOD ladder read it from one place. */
export function inkMinRadius(outline: { readonly segments: Float64Array; readonly discs: Float64Array }): number {
    let radius = Infinity;
    const segments = outline.segments, discs = outline.discs;
    for (let i = 0; i < segments.length; i += 6) radius = Math.min(radius, segments[i + 2], segments[i + 5]);
    for (let i = 0; i < discs.length; i += 3) radius = Math.min(radius, discs[i + 2]);
    return radius;
}
/** The centre-error bound a level of this radius may take, in world units: the same fraction as the outline's F1 tolerance,
 * so a LOD level is held to the error its own geometry is built to. The fraction is scale-free, so it holds at every zoom. */
export function inkRadiusTolerance(radiusWorld: number): number {
    return radiusWorld > 0 && Number.isFinite(radiusWorld) ? INK_TOLERANCE_RADIUS_FRACTION * radiusWorld : 0;
}
/** The adapter's outline ceiling: an outline past it has no triangles, and the route refuses the stroke. */
const INK_OUTLINE_MAX_COMMANDS = 262144;

/** The device-scale band that geometry is built for: the upper edge of the half-octave that holds `deviceScale`. An
 * outline built at the band's top holds 0.1 device px there and less at every lower scale in the band. */
export function inkToleranceBand(deviceScale: number): number {
    return 2 ** (Math.ceil(2 * Math.log2(deviceScale)) / 2);
}

export interface InkTriangles {
    /** Origin-relative triangles, x and y per vertex. Positive and negative are folded together: the union rule draws every one. */
    readonly triangles: Float64Array;
    readonly origin: Readonly<{ x: number; y: number }>;
    readonly bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
    readonly edges: number;
    /** The kit's shape for these triangles, built with them: the kit keys its vertex buffer by `positive`'s identity, and a
     * new shape object per admission would otherwise be a new allocation on every publication. */
    readonly shape: PathCoverageShapes;
}
const NO_TRIANGLES = new Float64Array(0);
function triangleSet(triangles: Float64Array, origin: Readonly<{ x: number; y: number }>,
    bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>, edges: number): InkTriangles {
    return { triangles, origin, bounds, edges, shape: { positive: triangles, negative: NO_TRIANGLES, edges, bounds } };
}
const ZERO_BOUNDS: Readonly<{ x0: number; y0: number; x1: number; y1: number }> = Object.freeze({ x0: 0, y0: 0, x1: 0, y1: 0 });
const ZERO_ORIGIN: Readonly<{ x: number; y: number }> = Object.freeze({ x: 0, y: 0 });

/** The chunk geometry a route holds, leased: every triangle array this cache keeps is reserved with the governor (the CPU
 * pool, through the route's allocator) and released when it is evicted. By reading: the old module-level WeakMaps held
 * this memory outside the governor's books, so a pane could hold more than it was granted and never be told. Entries are
 * evicted least recently used, but never one the current stroke is using (its sets are being admitted now). */
export type InkStrokeSetsResult = InkStrokeSets | null | { readonly denied: number };
export interface InkGeometry {
    /** The stroke's sets at one band; `null` when a chunk is refused; `{ denied }` when the pool refuses the bytes even after eviction. */
    strokeSets(item: PaintInkItem, band: number): InkStrokeSetsResult;
    memory(): { readonly cpuBytes: number };
    /** Frees up to `wanted` bytes of idle chunks, least recently used first: never the current publication's chunks, nor any in `keep`
     * (the chunks a shown run still maps). Returns the bytes freed. */
    evictIdle(wanted: number, keep: ReadonlySet<InkCoverage>): number;
    release(): void;
}
interface Held {
    readonly band: number; readonly px: number; readonly py: number;
    readonly local: InkTriangles | null; readonly placed: InkTriangles | null;
    leases: ByteLease[]; bytes: number; use: number;
}
type Placed = InkTriangles | null | { readonly denied: number };

export function createInkGeometry(memory: MemoryAllocator, audit: string): InkGeometry {
    // Insertion order is recency: a touch moves the chunk to the end, so the first entry is the least recently used.
    const held = new Map<InkCoverage, Held>();
    let bytes = 0, epoch = 0;
    const free = (entry: Held): void => {
        for (const lease of entry.leases) memory.release(lease);
        bytes -= entry.bytes; entry.leases = []; entry.bytes = 0;
    };
    const evictOne = (keep: Held): boolean => {
        for (const [chunk, entry] of held) {
            if (entry === keep || entry.use === epoch) continue;
            free(entry); held.delete(chunk); return true;
        }
        return false;
    };
    /** Reserves the array's bytes for `entry`, evicting others to make room. False when the pool still refuses. */
    const claim = (entry: Held, triangles: InkTriangles, size: number): boolean => {
        if (!triangles.triangles.byteLength) return true;
        let lease = memory.reserve(size);
        while (!lease && evictOne(entry)) lease = memory.reserve(size);
        if (!lease) return false;
        entry.leases.push(lease); entry.bytes += size; bytes += size;
        return true;
    };
    /** Whether an outline built for band `held` serves band `band`: a finer one (up to an octave above) is more precise at every
     * lower scale (see inkToleranceBand), so it serves. One band per chunk was rebuilt at each half-octave a zoom crossed, and a
     * zoom wavering across one rebuilt every chunk on every frame (measured, LARGE=11 board, WebGL2, DPR 2: the outlines were 75%
     * of the board's prepare, 388 of 521 ms on a paced zoom, 923 builds); held finer, a wavering zoom rebuilds once. A coarser one
     * is never served: served while the view moved, it stayed on screen at rest when the board rested on its last live picture
     * (f4's fidelity kit, DPR 2 at 332%: the drawn outline a half-octave coarser than the scene's, a 0.04 px edge offset). */
    const serves = (held: number, band: number): boolean => held === band || (held > band && held <= 2 * band);
    const place = (chunk: InkCoverage, band: number, origin: Readonly<{ x: number; y: number }>): Placed => {
        const old = held.get(chunk);
        if (old && serves(old.band, band) && old.px === origin.x && old.py === origin.y) {
            held.delete(chunk); held.set(chunk, old); old.use = epoch; auditCount(audit, old.band === band ? 'geom:hit' : 'geom:hit:near-band');
            return old.placed;
        }
        // The local build survives a change of origin (a copy, not a re-tessellation); a change of band rebuilds it.
        const kept = old && serves(old.band, band) ? old.local : undefined;
        if (old) { free(old); held.delete(chunk); }
        const local = kept !== undefined ? (auditCount(audit, 'geom:hit'), kept) : buildLocal(chunk, band, audit);
        const entry: Held = { band: kept !== undefined && old ? old.band : band, px: origin.x, py: origin.y, local, placed: null, leases: [], bytes: 0, use: epoch };
        if (local && !claim(entry, local, local.triangles.byteLength)) { free(entry); return { denied: local.triangles.byteLength }; }
        const placed = local && rebase(local, origin);
        if (placed && placed !== local && !claim(entry, placed, placed.triangles.byteLength)) {
            free(entry); return { denied: placed.triangles.byteLength };
        }
        held.set(chunk, { ...entry, placed });
        return placed;
    };
    return {
        strokeSets(item: PaintInkItem, band: number): InkStrokeSetsResult {
            epoch++;
            const chunks = inkCoverageChunks(item.coverage);
            if (!chunks.length) return { origin: ZERO_ORIGIN, sets: [], shapes: [] };
            // The first chunk's corner: fixed while a live stroke appends chunks, so the placed sets stay valid across publications.
            const origin = { x: chunks[0].boundsLocal.x, y: chunks[0].boundsLocal.y };
            const sets: InkTriangles[] = [];
            for (const chunk of chunks) {
                const placed = place(chunk, band, origin);
                if (placed && 'denied' in placed) return placed;
                if (!placed) return null;
                if (placed.triangles.length) sets.push(placed);
            }
            return { origin, sets, shapes: sets.map(set => set.shape) };
        },
        evictIdle(wanted: number, keep: ReadonlySet<InkCoverage>): number {
            let freed = 0;
            for (const [chunk, entry] of held) {
                if (freed >= wanted) break;
                if (entry.use === epoch || keep.has(chunk)) continue;
                const size = entry.bytes; free(entry); held.delete(chunk); freed += size;
            }
            return freed;
        },
        memory: () => ({ cpuBytes: bytes }),
        release(): void {
            for (const entry of held.values()) free(entry);
            held.clear(); bytes = 0;
        },
    };
}

/** One chunk's union triangles at one band, in the chunk's own corner. `null` when the outline exceeds its budget (the caller
 * refuses the stroke, counted by the route); a build that fails for any other reason is not caught. */
function buildLocal(chunk: InkCoverage, band: number, audit: string): InkTriangles | null {
    auditCount(audit, 'geom:build');
    const origin = { x: chunk.boundsLocal.x, y: chunk.boundsLocal.y };
    try {
        const { arcPx, flattenPx } = inkTolerances(chunk, band);
        // coverageOutline's arc tolerance is INK_CAP_ERROR_DEVICE_PX / deviceScale (its only use of the scale), so this
        // scale sets the arcs to the chunk's arc tolerance and nothing else about the outline changes.
        const commands = coverageOutline(chunk, band * (INK_CAP_ERROR_DEVICE_PX / arcPx), INK_OUTLINE_MAX_COMMANDS);
        const shapes = pathFillTriangles(commands, { tolerance: flattenPx / band, origin: [origin.x, origin.y] });
        return shapes ? foldUnion(shapes, origin) : null;
    } catch (error) {
        // Only the outline's own ceilings are RangeErrors that mean "refused"; anything else is a fault.
        if (error instanceof RangeError) return null;
        throw error;
    }
}
/** The device-px errors this chunk's outline may have: a fraction of its thinnest device radius, each under its ceiling.
 * By reading, every chunk reaches this one builder, so the F1 bound holds for the wet stroke, the committed stroke and every LOD
 * level alike: a LOD level's chunks are InkCoverage objects of their own, tessellated here at their own radius. */
function inkTolerances(chunk: InkCoverage, band: number): { arcPx: number; flattenPx: number } {
    const radius = inkMinRadius(chunk);
    if (!(radius < Infinity)) return { arcPx: INK_CAP_ERROR_DEVICE_PX, flattenPx: INK_FLATTEN_DEVICE_PX };
    const fraction = Math.max(INK_TOLERANCE_FLOOR_PX, INK_TOLERANCE_RADIUS_FRACTION * radius * band);
    return { arcPx: Math.min(INK_CAP_ERROR_DEVICE_PX, fraction), flattenPx: Math.min(INK_FLATTEN_DEVICE_PX, fraction) };
}
function foldUnion(shapes: PathFillTriangles, origin: Readonly<{ x: number; y: number }>): InkTriangles {
    const { positive, negative } = shapes;
    let triangles = positive;
    if (negative.length) {
        triangles = new Float64Array(positive.length + negative.length);
        triangles.set(positive, 0); triangles.set(negative, positive.length);
    }
    return triangleSet(triangles, origin, triangles.length ? shapes.bounds : ZERO_BOUNDS, shapes.edges);
}
/** A chunk's triangles rebased to a stroke's origin, so every chunk of the stroke shares one affine. The copy is the identity
 * the kit shares a vertex buffer by: a publication uploads only the chunks it adds. */
function rebase(local: InkTriangles, origin: Readonly<{ x: number; y: number }>): InkTriangles {
    const dx = local.origin.x - origin.x, dy = local.origin.y - origin.y;
    if (dx === 0 && dy === 0) return local;
    const source = local.triangles, triangles = new Float64Array(source.length);
    for (let i = 0; i < source.length; i += 2) {
        triangles[i] = source[i] + dx;
        triangles[i + 1] = source[i + 1] + dy;
    }
    const b = local.bounds;
    return triangleSet(triangles, origin, source.length ? { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy } : ZERO_BOUNDS,
        local.edges);
}

/** A stroke as its chunks' sets, all relative to `origin`. Only non-empty sets are listed. */
export interface InkStrokeSets {
    readonly origin: Readonly<{ x: number; y: number }>;
    readonly sets: readonly InkTriangles[];
    /** `sets`' kit shapes, in the same order: what the union route admits, with no per-admission array of its own. */
    readonly shapes: readonly PathCoverageShapes[];
}
