import { CURVE_CHUNK_SPANS, type CurveParameters, type CurveRange } from '../ink/curve';
import type { CoverageOptions, InkCoverage } from '../ink/outline';
import { readPackedInkCoverage } from '../ink/packedCoverage';
import type { SampleSequence } from '../ink/samples';
import { DOT_METRIC_PROVISIONAL, type InkWidth } from '../ink/width';
import { yieldToHost } from '../../platform/yieldToHost';
import { auditCount } from '../../platform/render/renderAudit';
import { boardWorkerPoolMember, boardWorkerPoolState, dedicatedBoardWorker, endBoardWorkerPoolMember, type BoardWorkerClient } from './client';
import { INK_BATCH_MAX_ITEMS, INK_GEOMETRY_CRASHED, inkBatchSampleBytes, type InkBatchItem, type InkBatchReply, type InkBatchRequest,
    type InkBatchResult, type InkCoverageReply } from './geometryProtocol';
import type { BoardJobIdentity } from './protocol';

const AUDIT = 'board-paint';

/** The stroke's held LOD levels, as this client needs them; the render-side ladder implements it. */
export interface InkLodPort {
    coarsest(budget: number): InkCoverageReply | null;
    add(reply: InkCoverageReply): boolean;
}

// Chunks asked for in one task with one abort signal travel as ONE `ink.batch` request: one message and one transfer each way,
// the samples of every chunk in one input buffer and every coverage packed in one reply (inkBatchHandler.ts). A batch leaves at
// the end of the task that filled it, or at once when it is full. It is keyed by its signal as well as its document: a paint
// stream passes one signal for all its strokes, so a replaced stream's batch is cancelled in the worker as one unit, where a batch
// shared with another stream was cancelled only once both were. Measured (WebGL2, Strokes-3 and a 10,060-stroke drawing): a
// stream fills 9 to 15 chunks a task (10,060 chunks in 1,094 requests on the open), so a batch's first chunk waits for a few
// builds at most, and answering in parts as the worker went (tried) changed nothing measurable.
/** Sample bytes one batch carries before it leaves without waiting for the task to end. */
const BATCH_INPUT_BYTES = 1 << 20;
/** Geometry workers a task's chunks are spread over: one is the shared geometry worker, the rest are made when a task first asks
 * for enough chunks to give each at least `POOL_SHARE`, so a board's edits and small views never start one. Bounded below the
 * cores, which the main thread, the compositor and the GPU process share. Measured (WebGL2, Strokes-3 native, 5,640 strokes):
 * with one worker it was busy for the whole 1.36 s of the geometry phase, a third of that the per-request overhead batching
 * removes, while the main thread was idle half the time. */
const POOL_SIZE = Math.max(1, Math.min(3, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4) - 2));
const POOL_SHARE = 32;
/** An extra pool member with no batch for this long is ended, so the garbage of its last batches goes with its isolate instead of
 * staying until a collection that an idle isolate seldom runs. The shared member 0 is kept: 30 s after a 10,060-stroke drawing
 * opened its heap was 0.7 MB, and recycling it put a worker start in front of the next zoom's geometry. */
const POOL_IDLE_MS = 5_000;

interface Pending {
    readonly item: Omit<InkBatchItem, 'at'>;
    readonly xy: Float64Array; readonly pressure: Float64Array | null; readonly kinds: Uint8Array;
    readonly isCurrent: (identity: BoardJobIdentity) => boolean;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (value: { coverage: InkCoverage; level: 'fine' | 'coarse' }) => void;
    readonly reject: (error: unknown) => void;
    settled: boolean;
    /** Called once the item's own signal aborts: settles it, and aborts its request once every item of it has. */
    onAbort: () => void;
    /** The listener on `signal`, which calls the current `onAbort`. */
    readonly listener: () => void;
}
interface Batch { readonly identity: BoardJobIdentity; readonly items: Pending[]; bytes: number }
const open = new Map<string, Batch>();
let flushing: Promise<void> | null = null, nextSignal = 0;
const signalIds = new WeakMap<AbortSignal, number>();
/** Requests in flight per pool member, and its idle timer. */
const members: { requests: number; idle?: ReturnType<typeof setTimeout> }[] = [];

/** Chunks whose geometry crashed the isolation worker, for the page's life: asking again would only crash a worker again, and four
 * crashes in a minute fail it (platform/workers/client.ts). Keyed by the board session and the chunk's samples, not by its
 * precision band, so a zoom does not try it again. */
const crashed = new Set<string>();
/** The worker a crashed batch's chunks are asked again on, one at a time, so a crash there is that chunk's own. Retried side by side
 * on the pool, a chunk in flight beside the bad one crashed with it: in one run of Strokes-3 two innocent strokes were refused, and
 * with them 1,618 strokes drawn from the same samples. Made when a batch crashes, ended once its queue is empty. */
let isolation: { readonly client: BoardWorkerClient & { dispose(): void }; queue: Promise<unknown>; waiting: number } | null = null;
function crashKey(identity: BoardJobIdentity, pending: Pick<Pending, 'item' | 'xy'>): string {
    // Every sample's bits, hashed (FNV-1a): strokes are stored in their own coordinates, so many start at the same point with the
    // same sample count, and a key of a few samples refused 270 strokes of Strokes-3 for one that crashed.
    const { item, xy } = pending, words = new Uint32Array(xy.buffer, xy.byteOffset, xy.length * 2);
    let hash = 0x811c9dc5;
    for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], 0x01000193);
    return `${identity.session}\n${item.totalCount}\n${item.indexOffset}\n${item.range.firstSpan}\n${item.range.spanCount}\n${xy.length}\n${hash >>> 0}`;
}
function crashedError(): Error {
    const error = new Error('This stroke\'s geometry crashed the geometry worker');
    error.name = INK_GEOMETRY_CRASHED;
    return error;
}
function keyOf(identity: BoardJobIdentity, signal: AbortSignal | undefined): string {
    let id = 0;
    if (signal) { id = signalIds.get(signal) ?? ++nextSignal; signalIds.set(signal, id); }
    return `${identity.session}\n${identity.epoch}\n${identity.revision}\n${id}`;
}
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
/** The pool members that may take work: those that have not failed. A member that failed refuses every request until a cool-down
 * passes, so its share would fail at once; with every member failed the shared one is asked, and its failure is the answer. */
function liveMembers(wanted: number): number[] {
    const live: number[] = [];
    for (let member = 0; member < POOL_SIZE && live.length < wanted; member++) {
        if (boardWorkerPoolState('geometry', member) !== 'failed') live.push(member);
    }
    return live.length ? live : [0];
}
/** Sends a task's chunks as one batch per pool member it needs, in order: the first share holds the chunks the stream takes first. */
function dispatch(batch: Batch): void {
    const live = liveMembers(Math.max(1, Math.min(POOL_SIZE, Math.floor(batch.items.length / POOL_SHARE))));
    const share = Math.ceil(batch.items.length / live.length);
    live.forEach((member, index) => {
        const items = batch.items.slice(index * share, (index + 1) * share);
        if (items.length) void send(batch.identity, items, member);
    });
}
function settle(pending: Pending): boolean {
    if (pending.settled) return false;
    pending.settled = true;
    pending.signal?.removeEventListener('abort', pending.listener);
    return true;
}
function answer(pending: Pending, identity: BoardJobIdentity, output: ArrayBuffer, result: InkBatchResult): void {
    if (!settle(pending)) { auditCount(AUDIT, 'ink:batch-stale'); return; }
    try {
        if ('error' in result) {
            const error = new Error(result.error);
            error.name = result.name;
            throw error;
        }
        if (!pending.isCurrent(identity)) throw new DOMException('Board job is stale', 'AbortError');
        // Each chunk keeps a buffer of its own: a view on the shared reply would hold the whole batch while one stroke lives.
        pending.resolve({ coverage: readPackedInkCoverage(output.slice(result.at, result.at + result.bytes), 0).coverage, level: result.level });
    } catch (error) { pending.reject(error); }
}
/** Asks for one chunk on the isolation worker, after every chunk queued there before it. */
function isolate(identity: BoardJobIdentity, pending: Pending): Promise<unknown> {
    const worker = isolation ??= { client: dedicatedBoardWorker('geometry'), queue: Promise.resolve(), waiting: 0 };
    worker.waiting++;
    const run = worker.queue.then(() => send(identity, [pending], 'isolated'));
    worker.queue = run.catch(() => {}).finally(() => {
        if (--worker.waiting === 0 && isolation === worker) { isolation = null; worker.client.dispose(); }
    });
    return run;
}
/** Sends one `ink.batch` request to pool member `target`, or to the isolation worker; settles when it and any retries it led to
 * have. */
function send(identity: BoardJobIdentity, all: readonly Pending[], target: number | 'isolated'): Promise<unknown> {
    const items = all.filter(pending => !pending.settled);
    if (!items.length) return Promise.resolve();
    let bytes = 0;
    for (const pending of items) bytes += inkBatchSampleBytes(pending.item.count, pending.item.pressure);
    const input = new ArrayBuffer(bytes), described: InkBatchItem[] = [];
    let at = 0;
    for (const pending of items) {
        const { count, pressure } = pending.item;
        new Float64Array(input, at, 2 * count).set(pending.xy);
        if (pending.pressure) new Float64Array(input, at + 16 * count, count).set(pending.pressure);
        new Uint8Array(input, at + (pressure ? 24 : 16) * count, count).set(pending.kinds);
        described.push({ ...pending.item, at });
        at += inkBatchSampleBytes(count, pressure);
    }
    // The request is cancelled only once every item of it is: an item cancelled alone is settled at once and its answer dropped.
    // A batch's items share one signal (keyOf), so a replaced stream cancels its request whole.
    const controller = new AbortController();
    let live = items.length;
    for (const pending of items) {
        const settleOne = pending.onAbort;
        pending.onAbort = () => { settleOne(); if (--live === 0) controller.abort(); };
    }
    const member = target === 'isolated' ? -1 : target;
    const client = member < 0 ? isolation!.client : boardWorkerPoolMember('geometry', member);
    const state = member < 0 ? null : members[member] ??= { requests: 0 };
    if (state?.idle !== undefined) { clearTimeout(state.idle); state.idle = undefined; }
    if (state) state.requests++;
    auditCount(AUDIT, 'ink:batch-sent', items.length);
    return client.request<InkBatchReply>('ink.batch', { input, items: described } satisfies InkBatchRequest, identity,
        { priority: 1, signal: controller.signal, transfer: [input] },
        current => items.some(pending => !pending.settled && pending.isCurrent(current))).then(reply => {
        if (!reply || !(reply.output instanceof ArrayBuffer) || !Array.isArray(reply.items) || reply.items.length !== items.length) {
            throw new TypeError('Invalid ink batch reply');
        }
        items.forEach((pending, index) => answer(pending, identity, reply.output, reply.items[index]));
    }).catch(error => {
        const left = items.filter(pending => !pending.settled);
        if (!left.length) return;
        if (error instanceof Error && error.name === 'WorkerCrashed') {
            // One stroke that crashes the worker would take the batch with it: each chunk left is asked again on its own, on the
            // isolation worker, so the one that crashes fails alone and the rest draw.
            if (member >= 0) {
                auditCount(AUDIT, 'ink:batch-retry', left.length);
                return Promise.all(left.map(pending => isolate(identity, pending)));
            }
            crashed.add(crashKey(identity, left[0]));
            if (settle(left[0])) left[0].reject(crashedError());
            return;
        }
        // A member that has failed for good (four crashes in a minute) refuses everything queued on it and everything asked of it
        // during its cool-down: those chunks go to a member still alive. With none left, its failure is the answer.
        if (member >= 0 && error instanceof Error && error.name === 'WorkerFailed') {
            const alive = liveMembers(POOL_SIZE).filter(other => other !== member && boardWorkerPoolState('geometry', other) !== 'failed');
            if (alive.length) { auditCount(AUDIT, 'ink:batch-redirect', left.length); return send(identity, left, alive[0]); }
        }
        for (const pending of left) if (settle(pending)) pending.reject(error);
    }).finally(() => {
        if (state && --state.requests === 0 && member > 0) state.idle = setTimeout(() => { state.idle = undefined; endBoardWorkerPoolMember('geometry', member); }, POOL_IDLE_MS);
    });
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
    if (crashed.has(crashKey(identity, { item, xy }))) throw crashedError();
    const { coverage, level } = await new Promise<{ coverage: InkCoverage; level: 'fine' | 'coarse' }>((resolve, reject) => {
        const pending: Pending = { item, xy, pressure, kinds, isCurrent, signal, resolve, reject, settled: false, onAbort: () => {
            if (pending.settled) return;
            pending.settled = true; reject(aborted(signal));
        }, listener: () => pending.onAbort() };
        signal?.addEventListener('abort', pending.listener, { once: true });
        const key = keyOf(identity, signal);
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
