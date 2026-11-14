import { CURVE_CHUNK_SPANS, type CurveParameters, type CurveRange } from '../ink/curve';
import type { CoverageOptions, InkCoverage } from '../ink/outline';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, radiusAtCurveParameter, type InkWidth } from '../ink/width';
import { boardWorker } from './client';
import type { InkCoverageReply, InkCoverageRequest } from './geometryProtocol';
import type { BoardJobIdentity } from './protocol';

/** Copies only one canonical range and its neighbours; the caller retains the original sequence. */
export async function prepareInkCoverageInWorker(samples: SampleSequence, parameters: CurveParameters,
    style: InkWidth, range: CurveRange, options: CoverageOptions, identity: BoardJobIdentity,
    signal: AbortSignal | undefined, isCurrent: (identity: BoardJobIdentity) => boolean): Promise<InkCoverage> {
    if (!Number.isSafeInteger(samples.count) || samples.count < 1 || !Number.isInteger(range.firstSpan)
        || !Number.isInteger(range.spanCount) || range.firstSpan < 0 || range.spanCount < 0
        || range.spanCount > CURVE_CHUNK_SPANS || range.firstSpan + range.spanCount >= samples.count) {
        throw new RangeError('Invalid worker ink range');
    }
    if (options.dotMetric && options.dotMetric !== DOT_METRIC_PROVISIONAL) throw new TypeError('Ink dot metric cannot be transferred');
    const first = Math.max(0, range.firstSpan - 2);
    const end = Math.min(samples.count, range.firstSpan + range.spanCount + 3);
    if (options.closed && (first !== 0 || end !== samples.count)) throw new RangeError('Closed ink needs its complete sample sequence');
    const count = end - first, xy = new Float64Array(2 * count), kinds = new Uint8Array(count);
    const pressure = style.pressure === 'real' ? new Float64Array(count) : null;
    for (let i = 0; i < count; i++) {
        const source = first + i;
        xy[2 * i] = samples.x(source); xy[2 * i + 1] = samples.y(source);
        if (pressure) {
            const value = samples.pressure(source);
            if (value === undefined) throw new RangeError('Missing ink pressure');
            pressure[i] = value;
        }
        if (source + 1 < samples.count) kinds[i] = samples.segmentKind(source) === 'straight' ? 1 : 0;
    }
    const { dotMetric: _dotMetric, ...plainOptions } = options;
    const payload: InkCoverageRequest = { samples: { xy, pressure, kinds, indexOffset: first, totalCount: samples.count },
        parameters, style, range, options: plainOptions };
    const transfer: Transferable[] = [xy.buffer, kinds.buffer];
    if (pressure) transfer.push(pressure.buffer);
    const reply = await boardWorker('geometry').request<InkCoverageReply>('ink.coverage', payload, identity,
        { priority: 1, signal, transfer }, isCurrent);
    return Object.freeze({ ...reply, radiusAt(span: number, t: number): number {
        const { arcMaps: maps, radii } = reply;
        if (!Number.isInteger(span) || span < 0 || span >= maps.length || !Number.isFinite(t) || t < 0 || t > 1) {
            throw new RangeError('Invalid ink radius span or parameter');
        }
        if ((options.dash || options.pointMotifs) && maps[span].upperLength === 0) return radii[2 * span + 1];
        return radiusAtCurveParameter(maps[span], radii[2 * span], radii[2 * span + 1], t);
    } });
}
