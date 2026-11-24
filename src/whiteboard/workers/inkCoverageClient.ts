import { CURVE_CHUNK_SPANS, type CurveParameters, type CurveRange } from '../ink/curve';
import type { CoverageOptions, InkCoverage } from '../ink/outline';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, radiusAtCurveParameter, type InkWidth } from '../ink/width';
import { boardWorker } from './client';
import type { InkCoverageReply, InkCoverageRequest } from './geometryProtocol';
import type { BoardJobIdentity } from './protocol';
import { TransferSlabs } from './slabs';

/** The stroke's held LOD levels, as this client needs them; the render-side ladder implements it. */
export interface InkLodPort {
    coarsest(budget: number): InkCoverageReply | null;
    add(reply: InkCoverageReply): boolean;
}

/** Copies only one canonical range and its neighbours; the caller retains the original sequence. */
export async function prepareInkCoverageInWorker(samples: SampleSequence, parameters: CurveParameters,
    style: InkWidth, range: CurveRange, options: CoverageOptions, identity: BoardJobIdentity,
    signal: AbortSignal | undefined, isCurrent: (identity: BoardJobIdentity) => boolean,
    lod?: { chunkCount: number; ladder?: InkLodPort; onChoice?: (level: 'fine' | 'coarse') => void }): Promise<InkCoverage> {
    if (!Number.isSafeInteger(samples.count) || samples.count < 1 || !Number.isInteger(range.firstSpan)
        || !Number.isInteger(range.spanCount) || range.firstSpan < 0 || range.spanCount < 0
        || range.spanCount > CURVE_CHUNK_SPANS || range.firstSpan + range.spanCount >= samples.count) {
        throw new RangeError('Invalid worker ink range');
    }
    if (options.dotMetric && options.dotMetric !== DOT_METRIC_PROVISIONAL) throw new TypeError('Ink dot metric cannot be transferred');
    // A held level that already fits serves the stroke: no worker round trip and no sample copy. Its radius
    // error is the same at every level, so it is checked here against this device scale as the worker would.
    const scale = options.deviceScale;
    const held = lod?.ladder && Number.isFinite(scale) && scale > 0 ? lod.ladder.coarsest(1 / 16 / scale) : null;
    if (held && held.radiusErrorWorld * scale <= 1 / 16) {
        lod?.onChoice?.('coarse');
        return withRadii(held, options);
    }
    const first = Math.max(0, range.firstSpan - 2);
    const end = Math.min(samples.count, range.firstSpan + range.spanCount + 3);
    if (options.closed && (first !== 0 || end !== samples.count)) throw new RangeError('Closed ink needs its complete sample sequence');
    const count = end - first, slabs = new TransferSlabs();
    const xyHandle = slabs.allocate(16 * count), kindsHandle = slabs.allocate(count);
    const pressureHandle = style.pressure === 'real' ? slabs.allocate(8 * count) : null;
    const xyBytes = slabs.view(xyHandle), kinds = slabs.view(kindsHandle);
    const xy = new Float64Array(xyBytes.buffer, xyBytes.byteOffset, 2 * count);
    const pressureBytes = pressureHandle ? slabs.view(pressureHandle) : null;
    const pressure = pressureBytes ? new Float64Array(pressureBytes.buffer, pressureBytes.byteOffset, count) : null;
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
    const moved = slabs.move(xyHandle);
    slabs.dispose();
    const payload: InkCoverageRequest = { samples: {
        xy: new Float64Array(moved.buffer, xyHandle.offset, 2 * count),
        pressure: pressureHandle ? new Float64Array(moved.buffer, pressureHandle.offset, count) : null,
        kinds: new Uint8Array(moved.buffer, kindsHandle.offset, count), indexOffset: first, totalCount: samples.count,
    }, parameters, style, range, options: plainOptions };
    const client = boardWorker('geometry');
    let request: Promise<unknown> | undefined, reply: InkCoverageReply, choice: 'fine' | 'coarse' | undefined;
    try {
        if (lod) {
            const pending = client.request<{ coverage: InkCoverageReply; level: 'fine' | 'coarse' }>('ink.lod',
                { request: payload, chunkCount: lod.chunkCount }, identity, { priority: 1, signal, transfer: [moved.buffer] }, isCurrent);
            request = pending;
            const result = await pending;
            reply = result.coverage;
            choice = result.level;
        } else {
            const pending = client.request<InkCoverageReply>('ink.coverage', payload, identity,
                { priority: 1, signal, transfer: [moved.buffer] }, isCurrent);
            request = pending;
            reply = await pending;
        }
    } finally {
        try { if (request) await client.whenRetired(request); }
        finally { moved.release(); }
    }
    if (choice) lod?.onChoice?.(choice);
    // Only a coarse reply is new LOD; fine replies are the samples' own geometry and are not kept.
    if (choice === 'coarse') lod?.ladder?.add(reply);
    return withRadii(reply, options);
}

/** The reply plus its radius lookup. The bare reply is what a ladder keeps, so both paths share this. */
function withRadii(reply: InkCoverageReply, options: CoverageOptions): InkCoverage {
    return Object.freeze({ ...reply, radiusAt(span: number, t: number): number {
        const { arcMaps: maps, radii } = reply;
        if (!Number.isInteger(span) || span < 0 || span >= maps.length || !Number.isFinite(t) || t < 0 || t > 1) {
            throw new RangeError('Invalid ink radius span or parameter');
        }
        if ((options.dash || options.pointMotifs) && maps[span].upperLength === 0) return radii[2 * span + 1];
        return radiusAtCurveParameter(maps[span], radii[2 * span], radii[2 * span + 1], t);
    } });
}
