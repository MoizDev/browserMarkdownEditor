import { CURVE_CHUNK_SPANS, type CurveParameters, type CurveRange } from '../ink/curve';
import type { CoverageOptions, InkCoverage } from '../ink/outline';
import { readPackedInkCoverage } from '../ink/packedCoverage';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, type InkWidth } from '../ink/width';
import { yieldToHost } from '../../platform/yieldToHost';
import { boardWorkerPoolMember } from './client';
import { INK_BATCH_MAX_ITEMS, inkBatchSampleBytes, type InkBatchItem, type InkBatchReply, type InkCoverageReply } from './geometryProtocol';
import type { BoardJobIdentity } from './protocol';

/** The stroke's held LOD levels, as this client needs them; the render-side ladder implements it. */
export interface InkLodPort {
    coarsest(budget: number): InkCoverageReply | null;
    add(reply: InkCoverageReply): boolean;
}

// Chunks asked for in one task travel as ONE `ink.batch` request: one message and one transfer each way, the samples of every
// chunk in one input buffer and every coverage packed in one reply (inkBatchHandler.ts). A batch leaves at the end of the task
// that filled it (a paint stream asks for its whole look-ahead in one task), or at once when it is full.
/** Sample bytes one batch carries before it leaves without waiting for the task to end. */
const BATCH_INPUT_BYTES = 1 << 20;
/** Geometry workers a task's chunks are spread over: one is the shared geometry worker, the rest are made when a task first asks
 * for enough chunks to give each at least `POOL_SHARE`, so a board's edits and small views never start one. Bounded below the
 * cores, which the main thread, the compositor and the GPU process share. Measured (WebGL2, Strokes-3 native, 5,640 strokes):
 * with one worker it was busy for the whole 1.36 s of the geometry phase, a third of that the per-request overhead batching
 * removes, while the main thread was idle half the time. */
const POOL_SIZE = Math.max(1, Math.min(3, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4) - 2));
const POOL_SHARE = 32;

interface Pending {
    readonly item: Omit<InkBatchItem, 'at'>;
    readonly xy: Float64Array; readonly pressure: Float64Array | null; readonly kinds: Uint8Array;
    readonly isCurrent: (identity: BoardJobIdentity) => boolean;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (value: { coverage: InkCoverage; level: 'fine' | 'coarse' }) => void;
    readonly reject: (error: unknown) => void;
    settled: boolean;
    /** Called once the item's own signal aborts: settles it, and aborts its batch once every item of it has. */
    onAbort: () => void;
    /** The listener on `signal`, which calls the current `onAbort`. */
    readonly listener: () => void;
}
interface Batch { readonly identity: BoardJobIdentity; readonly items: Pending[]; bytes: number }
const open = new Map<string, Batch>();
let flushing: Promise<void> | null = null;

const keyOf = (identity: BoardJobIdentity): string => `${identity.session}\n${identity.epoch}\n${identity.revision}`;
function aborted(signal: AbortSignal | undefined): unknown {
    return signal?.reason ?? new DOMException('Ink coverage request aborted', 'AbortError');
}
function scheduleFlush(): void {
    flushing ??= yieldToHost().then(() => {
        flushing = null;
        const batches = [...open.values()];
        open.clear();
        for (const batch of batches) dispatch(batch);
    });
}
/** Sends a task's chunks as one batch per pool member it needs, in order: the first share holds the chunks the stream takes first. */
function dispatch(batch: Batch): void {
    const members = Math.max(1, Math.min(POOL_SIZE, Math.floor(batch.items.length / POOL_SHARE)));
    if (members === 1) { send(batch, 0); return; }
    const share = Math.ceil(batch.items.length / members);
    for (let member = 0; member < members; member++) {
        const items = batch.items.slice(member * share, (member + 1) * share);
        let bytes = 0;
        for (const pending of items) bytes += inkBatchSampleBytes(pending.item.count, pending.item.pressure);
        if (items.length) send({ identity: batch.identity, items, bytes }, member);
    }
}
function send(batch: Batch, member: number): void {
    const items = batch.items.filter(pending => !pending.settled);
    if (!items.length) return;
    const input = new ArrayBuffer(batch.bytes), described: InkBatchItem[] = [];
    let at = 0;
    for (const pending of items) {
        const { count, pressure } = pending.item;
        new Float64Array(input, at, 2 * count).set(pending.xy);
        if (pending.pressure) new Float64Array(input, at + 16 * count, count).set(pending.pressure);
        new Uint8Array(input, at + (pressure ? 24 : 16) * count, count).set(pending.kinds);
        described.push({ ...pending.item, at });
        at += inkBatchSampleBytes(count, pressure);
    }
    // The batch is cancelled only once every item of it is: an item cancelled alone is settled at once and its answer dropped.
    const controller = new AbortController();
    let live = items.length;
    for (const pending of items) {
        const settle = pending.onAbort;
        pending.onAbort = () => { settle(); if (--live === 0) controller.abort(); };
    }
    const settleAll = (error: unknown) => {
        for (const pending of items) if (!pending.settled) { pending.settled = true; pending.signal?.removeEventListener('abort', pending.listener); pending.reject(error); }
    };
    boardWorkerPoolMember('geometry', member).request<InkBatchReply>('ink.batch', { input, items: described }, batch.identity,
        { priority: 1, signal: controller.signal, transfer: [input] },
        identity => items.some(pending => !pending.settled && pending.isCurrent(identity))).then(reply => {
        if (!reply || !(reply.output instanceof ArrayBuffer) || !Array.isArray(reply.items) || reply.items.length !== items.length) {
            throw new TypeError('Invalid ink batch reply');
        }
        items.forEach((pending, index) => {
            if (pending.settled) return;
            pending.settled = true;
            pending.signal?.removeEventListener('abort', pending.listener);
            const result = reply.items[index];
            try {
                if ('error' in result) {
                    const error = new Error(result.error);
                    error.name = result.name;
                    throw error;
                }
                if (!pending.isCurrent(batch.identity)) throw new DOMException('Board job is stale', 'AbortError');
                // Each chunk keeps a buffer of its own: a view on the shared reply would hold the whole batch while one stroke lives.
                const coverage = readPackedInkCoverage(reply.output.slice(result.at, result.at + result.bytes), 0).coverage;
                pending.resolve({ coverage, level: result.level });
            } catch (error) { pending.reject(error); }
        });
    }).catch(settleAll);
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
    signal?.throwIfAborted();
    // A held level that already fits serves the stroke: no worker round trip and no sample copy. Its radius
    // error is the same at every level, so it is checked here against this device scale as the worker would.
    const scale = options.deviceScale;
    const held = lod?.ladder && Number.isFinite(scale) && scale > 0 ? lod.ladder.coarsest(1 / 16 / scale) : null;
    if (held && held.radiusErrorWorld * scale <= 1 / 16) {
        lod?.onChoice?.('coarse');
        return held;
    }
    const first = Math.max(0, range.firstSpan - 2);
    const end = Math.min(samples.count, range.firstSpan + range.spanCount + 3);
    if (options.closed && (first !== 0 || end !== samples.count)) throw new RangeError('Closed ink needs its complete sample sequence');
    const count = end - first, real = style.pressure === 'real';
    const xy = new Float64Array(2 * count), kinds = new Uint8Array(count), pressure = real ? new Float64Array(count) : null;
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
    const item: Omit<InkBatchItem, 'at'> = { count, pressure: real, indexOffset: first, totalCount: samples.count, parameters, style, range,
        options: plainOptions, ...(lod ? { lodChunks: lod.chunkCount } : {}) };
    const { coverage, level } = await new Promise<{ coverage: InkCoverage; level: 'fine' | 'coarse' }>((resolve, reject) => {
        const pending: Pending = { item, xy, pressure, kinds, isCurrent, signal, resolve, reject, settled: false, onAbort: () => {
            if (pending.settled) return;
            pending.settled = true; reject(aborted(signal));
        }, listener: () => pending.onAbort() };
        signal?.addEventListener('abort', pending.listener, { once: true });
        const key = keyOf(identity);
        let batch = open.get(key);
        if (!batch) open.set(key, batch = { identity: Object.freeze({ ...identity }), items: [], bytes: 0 });
        batch.items.push(pending); batch.bytes += inkBatchSampleBytes(count, real);
        if (batch.items.length >= INK_BATCH_MAX_ITEMS || batch.bytes >= BATCH_INPUT_BYTES) { open.delete(key); dispatch(batch); }
        else scheduleFlush();
    });
    lod?.onChoice?.(level);
    // Only a coarse reply is new LOD; fine replies are the samples' own geometry and are not kept.
    if (level === 'coarse') lod?.ladder?.add(coverage);
    return coverage;
}
