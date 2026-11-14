import { styleGeometryMetrics } from '../geom/styleMetrics';
import { CURVE_CHUNK_SPANS, CURVE_VERSION, curveParameters, materializeCurveRange } from '../ink/curve';
import { InkCoverageJob, type CoverageOptions, type InkCoverage } from '../ink/outline';
import type { SampleSequence, SegmentKind } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, radiusAtSample, realizeStrokePoints, validateInkWidth, type InkWidth } from '../ink/width';
import type { StrokeNode } from '../model/nodes';
import type { SampleChunk, SampleStoreReader } from '../model/samples';

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

/** Chunks are one stroke's union, not independently composited alpha bands. */
export async function buildStrokeCoverage(node: StrokeNode, samples: SampleStoreReader, options: {
    deviceScale: number; cooperate?: () => Promise<void>; signal?: AbortSignal;
}): Promise<readonly InkCoverage[]> {
    const check = () => options.signal?.throwIfAborted();
    const cooperate = async () => {
        check();
        await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
        check();
    };
    check();
    if (!Number.isFinite(options.deviceScale) || options.deviceScale <= 0 || node.geomVersion !== CURVE_VERSION) {
        throw new RangeError('Unsupported stroke geometry version or device scale');
    }
    if (node.dash === 'none') return Object.freeze([]);
    const points = realizeStrokePoints(sequence(samples, node), node.sx, node.sy);
    const width: InkWidth = { width: node.width, model: node.widthModel, pressure: node.pressure };
    validateInkWidth(width);
    // Parameter scale is an admission bound, not a transform: the saved tolerance
    // and realized points determine the curve independently of the current camera.
    const parameterScale = node.fairTol > 0 ? Math.min(options.deviceScale, 0.125 / node.fairTol) : options.deviceScale;
    const parameters = curveParameters(parameterScale, node.fairTol, 1);
    let started = performance.now(), work = 0;
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const yieldWork = async () => { await cooperate(); work = 0; started = performance.now(); };
    const x0 = points.x(0), y0 = points.y(0);
    let dot = true, maxRadius = radiusAtSample(points, 0, width), slope = 0;
    for (let i = 1; i < points.count; i++) {
        if (due()) await yieldWork();
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
            const geometry = materializeCurveRange(points, { firstSpan: start, spanCount: Math.min(CURVE_CHUNK_SPANS, total - start) }, parameters);
            for (let i = 0; i < geometry.spanCount; i++) {
                if (due()) await yieldWork();
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
        const geometry = materializeCurveRange(points, { firstSpan: first, spanCount: count }, parameters);
        const job = new InkCoverageJob(points, geometry, width, { deviceScale: options.deviceScale, closed: false,
            dot: dotValue, dotMetric: DOT_METRIC_PROVISIONAL, ...pattern,
            ...(metric ? { arcPrefix: { distanceWorld: distance, errorWorld: error }, radiusSlopeBound: slope } : {}) });
        try {
            let status: 'pending' | 'complete' | 'cancelled';
            do {
                check();
                status = job.step(1);
                if (status === 'pending' && due()) await yieldWork();
            } while (status === 'pending');
            if (status !== 'complete') throw new DOMException('Ink geometry cancelled', 'AbortError');
            const coverage = job.result;
            chunks.push(coverage);
            distance += coverage.lengthWorld;
            error = coverage.dashPhaseErrorWorld;
        } finally { job.cancel(); }
        first += count;
        if (first < total) await yieldWork();
    } while (first < total);
    check();
    return Object.freeze(chunks);
}
