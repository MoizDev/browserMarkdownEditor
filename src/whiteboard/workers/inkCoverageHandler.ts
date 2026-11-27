import type { WorkerContext } from '../../platform/workers';
import { CURVE_CHUNK_SPANS, materializeCurveRange } from '../ink/curve';
import { InkCoverageJob, type InkCoverage } from '../ink/outline';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL } from '../ink/width';
import type { InkCoverageRequest } from './geometryProtocol';

export async function computeInkCoverage(request: InkCoverageRequest, context: WorkerContext, memory: (bytes: number) => void): Promise<InkCoverage> {
    if (!request || typeof request !== 'object') throw new TypeError('Invalid ink coverage request');
    const { samples, parameters, style, range, options } = request;
    if (!samples || !(samples.xy instanceof Float64Array) || !(samples.kinds instanceof Uint8Array)
        || (samples.pressure !== null && !(samples.pressure instanceof Float64Array)) || !range || !options
        || !Number.isSafeInteger(samples.indexOffset) || samples.indexOffset < 0
        || !Number.isSafeInteger(samples.totalCount) || samples.totalCount < 1
        || samples.xy.length % 2 || samples.kinds.length !== samples.xy.length / 2
        || (samples.pressure && samples.pressure.length !== samples.kinds.length)
        || samples.kinds.length > CURVE_CHUNK_SPANS + 5
        || samples.indexOffset + samples.kinds.length > samples.totalCount
        || !Number.isInteger(range.firstSpan) || !Number.isInteger(range.spanCount)
        || range.firstSpan < 0 || range.spanCount < 0 || range.spanCount > CURVE_CHUNK_SPANS
        || range.firstSpan + range.spanCount > samples.totalCount - 1
        || (options.closed && (samples.indexOffset !== 0 || samples.kinds.length !== samples.totalCount))) {
        throw new TypeError('Invalid ink coverage slabs');
    }
    const index = (i: number) => {
        const local = i - samples.indexOffset;
        if (!Number.isInteger(local) || local < 0 || local >= samples.kinds.length) throw new RangeError('Ink slab misses a canonical neighbour');
        return local;
    };
    const sequence: SampleSequence = {
        count: samples.totalCount,
        x: i => samples.xy[2 * index(i)], y: i => samples.xy[2 * index(i) + 1],
        pressure: i => samples.pressure?.[index(i)],
        segmentKind: i => samples.kinds[index(i)] ? 'straight' : 'freehand',
    };
    const closure = options.closure ?? null;
    if (closure && ![closure.beforeX, closure.beforeY, closure.afterX, closure.afterY].every(Number.isFinite)) throw new TypeError('Invalid ink closure');
    const geometry = materializeCurveRange(sequence, range, parameters, closure);
    const job = new InkCoverageJob(sequence, geometry, style, { ...options, dotMetric: DOT_METRIC_PROVISIONAL });
    memory(job.byteLength);
    try {
        let started = performance.now(), work = 0;
        for (;;) {
            context.signal.throwIfAborted();
            const status = job.step(1);
            if (status === 'cancelled') throw new DOMException('Ink coverage cancelled', 'AbortError');
            if (status === 'complete') { memory(job.byteLength); return job.coverage; }
            if (++work >= 256 || performance.now() - started >= 3) {
                memory(job.byteLength);
                await context.slice(); work = 0; started = performance.now();
            }
        }
    } finally { job.cancel(); }
}
