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

export interface InkLodPort {
    coarsest(budget: number): InkCoverageReply | null;
    add(reply: InkCoverageReply): boolean;
}

const BATCH_INPUT_BYTES = 1 << 20;
const POOL_SIZE = Math.max(1, Math.min(3, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4) - 2));
const POOL_SHARE = 32;
const POOL_IDLE_MS = 5_000;

interface Pending {
    readonly item: Omit<InkBatchItem, 'at'>;
    readonly xy: Float64Array; readonly pressure: Float64Array | null; readonly kinds: Uint8Array;
    readonly isCurrent: (identity: BoardJobIdentity) => boolean;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (value: { coverage: InkCoverage; level: 'fine' | 'coarse' }) => void;
    readonly reject: (error: unknown) => void;
    settled: boolean;
    onAbort: () => void;
    readonly listener: () => void;
}
interface Batch { readonly identity: BoardJobIdentity; readonly items: Pending[]; bytes: number }
const open = new Map<string, Batch>();
let flushing: Promise<void> | null = null, nextSignal = 0;
const signalIds = new WeakMap<AbortSignal, number>();
const members: { requests: number; idle?: ReturnType<typeof setTimeout> }[] = [];

const crashed = new Set<string>();
let isolation: { readonly client: BoardWorkerClient & { dispose(): void }; queue: Promise<unknown>; waiting: number } | null = null;
function crashKey(identity: BoardJobIdentity, pending: Pick<Pending, 'item' | 'xy'>): string {
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
function liveMembers(wanted: number): number[] {
    const live: number[] = [];
    for (let member = 0; member < POOL_SIZE && live.length < wanted; member++) {
        if (boardWorkerPoolState('geometry', member) !== 'failed') live.push(member);
    }
    return live.length ? live : [0];
}
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
        pending.resolve({ coverage: readPackedInkCoverage(output.slice(result.at, result.at + result.bytes), 0).coverage, level: result.level });
    } catch (error) { pending.reject(error); }
}
function isolate(identity: BoardJobIdentity, pending: Pending): Promise<unknown> {
    const worker = isolation ??= { client: dedicatedBoardWorker('geometry'), queue: Promise.resolve(), waiting: 0 };
    worker.waiting++;
    const run = worker.queue.then(() => send(identity, [pending], 'isolated'));
    worker.queue = run.catch(() => {}).finally(() => {
        if (--worker.waiting === 0 && isolation === worker) { isolation = null; worker.client.dispose(); }
    });
    return run;
}
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
            if (member >= 0) {
                auditCount(AUDIT, 'ink:batch-retry', left.length);
                return Promise.all(left.map(pending => isolate(identity, pending)));
            }
            crashed.add(crashKey(identity, left[0]));
            if (settle(left[0])) left[0].reject(crashedError());
            return;
        }
        if (member >= 0 && error instanceof Error && error.name === 'WorkerFailed') {
            const alive = liveMembers(POOL_SIZE).filter(other => other !== member && boardWorkerPoolState('geometry', other) !== 'failed');
            if (alive.length) { auditCount(AUDIT, 'ink:batch-redirect', left.length); return send(identity, left, alive[0]); }
        }
        for (const pending of left) if (settle(pending)) pending.reject(error);
    }).finally(() => {
        if (state && --state.requests === 0 && member > 0) state.idle = setTimeout(() => { state.idle = undefined; endBoardWorkerPoolMember('geometry', member); }, POOL_IDLE_MS);
    });
}

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
    if (level === 'coarse') lod?.ladder?.add(coverage);
    return coverage;
}
