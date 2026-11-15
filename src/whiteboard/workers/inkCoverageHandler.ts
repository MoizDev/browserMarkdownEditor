import type { WorkerContext } from '../../platform/workers';
import { CURVE_CHUNK_SPANS, materializeCurveRange } from '../ink/curve';
import { InkCoverageJob } from '../ink/outline';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL } from '../ink/width';
import { reportBoardMemory } from './boardMemory';
import type { InkCoverageRequest } from './geometryProtocol';

export async function inkCoverage(payload: unknown, context: WorkerContext): Promise<unknown> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid ink coverage request');
    const { samples, parameters, style, range, options } = payload as InkCoverageRequest;
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
    const owner = {}, inputBuffers = new Set([samples.xy.buffer, samples.kinds.buffer, ...(samples.pressure ? [samples.pressure.buffer] : [])]);
    let inputBytes = 0;
    for (const buffer of inputBuffers) inputBytes += buffer.byteLength;
    reportBoardMemory(context, owner, inputBytes);
    try {
        const geometry = materializeCurveRange(sequence, range, parameters);
        const job = new InkCoverageJob(sequence, geometry, style, { ...options, dotMetric: DOT_METRIC_PROVISIONAL });
        reportBoardMemory(context, owner, inputBytes + job.byteLength);
        try {
            let started = performance.now(), work = 0;
            for (;;) {
                context.signal.throwIfAborted();
                const status = job.step(1);
                if (status === 'cancelled') throw new DOMException('Ink coverage cancelled', 'AbortError');
                if (status === 'complete') {
                    const { radiusAt: _radiusAt, ...result } = job.result;
                    const buffers = new Set<ArrayBuffer>();
                    const collect = (value: unknown): void => {
                        if (!value || typeof value !== 'object') return;
                        if (ArrayBuffer.isView(value)) { if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer); return; }
                        for (const child of Object.values(value)) collect(child);
                    };
                    collect(result);
                    reportBoardMemory(context, owner, inputBytes + job.byteLength);
                    context.transfer(...buffers);
                    return result;
                }
                if (++work >= 256 || performance.now() - started >= 3) {
                    reportBoardMemory(context, owner, inputBytes + job.byteLength);
                    await context.slice(); work = 0; started = performance.now();
                }
            }
        } finally { job.cancel(); }
    } finally { reportBoardMemory(context, owner, null); }
}
