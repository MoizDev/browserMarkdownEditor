import { createWorkerClient, workerScript, type ClientState, type Priority, type RequestOptions, type WorkerClient } from '../../platform/workers';
import parseWorkerUrl from './parse.worker.ts?worker&url';
import geometryWorkerUrl from './geometry.worker.ts?worker&url';
import decodeWorkerUrl from '../media/decode.worker.ts?worker&url';
import exportWorkerUrl from './export.worker.ts?worker&url';
import { boardEnvelope, closeWorkerResult, matchingIdentity, validBoardIdentity } from './protocol';
import type { BoardJobIdentity, BoardWorkerEnvelope } from './protocol';

export type SharedBoardWorker = 'parse' | 'geometry' | 'decode' | 'export';
export interface BoardWorkerClient {
    request<T>(op: string, payload: unknown, identity: BoardJobIdentity, options: RequestOptions,
        isCurrent: (identity: BoardJobIdentity) => boolean): Promise<T>;
    whenRetired(request: Promise<unknown>): Promise<void>;
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    on(event: string, handler: (payload: unknown, identity: BoardJobIdentity) => void): () => void;
    cancelSession(session: string, epoch: number): void;
    recycle(reason: string): Promise<void>;
    readonly state: ClientState;
    readonly inFlight: number;
}
const clients = new Map<SharedBoardWorker, BoardWorkerClient>();
const parseWorker = workerScript(parseWorkerUrl, { keep: false });
const scripts = { parse: parseWorker, geometry: workerScript(geometryWorkerUrl, { keep: true }),
    decode: workerScript(decodeWorkerUrl, { keep: true }), export: workerScript(exportWorkerUrl, { keep: false }) };
function spawn(kind: SharedBoardWorker): Promise<Worker> { return scripts[kind].start(); }
export function importDeadline(byteLength: number): number {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new RangeError('Invalid import length');
    return Math.max(10_000, Math.ceil(byteLength * 30_000 / 100_000_000));
}
export const LEGACY_LOAD_DEADLINE_MS = 600_000;
function defaultDeadline(kind: SharedBoardWorker): number {
    return kind === 'decode' ? 10_000 : kind === 'export' ? 60_000 : 120_000;
}
export function boardWorker(kind: SharedBoardWorker): BoardWorkerClient {
    const existing = clients.get(kind);
    if (existing) return existing;
    const client = createBoardWorkerClient(kind, `whiteboard-${kind}`);
    clients.set(kind, client);
    return client;
}
const pools = new Map<SharedBoardWorker, (BoardWorkerClient & { dispose(): void } | undefined)[]>();
export function boardWorkerPoolMember(kind: SharedBoardWorker, index: number): BoardWorkerClient {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid board worker pool member');
    if (index === 0) return boardWorker(kind);
    let pool = pools.get(kind);
    if (!pool) pools.set(kind, pool = []);
    return pool[index - 1] ??= createBoardWorkerClient(kind, `whiteboard-${kind}-pool-${index}`);
}
export function boardWorkerPoolState(kind: SharedBoardWorker, index: number): ClientState {
    if (index === 0) return clients.get(kind)?.state ?? 'idle';
    return pools.get(kind)?.[index - 1]?.state ?? 'idle';
}
export function endBoardWorkerPoolMember(kind: SharedBoardWorker, index: number): void {
    const pool = pools.get(kind), member = index > 0 ? pool?.[index - 1] : undefined;
    if (!pool || !member || member.inFlight || member.state === 'failed') return;
    pool[index - 1] = undefined;
    member.dispose();
}
let dedicatedSerial = 0;
export function dedicatedBoardWorker(kind: SharedBoardWorker): BoardWorkerClient & { dispose(): void } {
    return createBoardWorkerClient(kind, `whiteboard-${kind}-own-${++dedicatedSerial}`);
}
function createBoardWorkerClient(kind: SharedBoardWorker, name: string): BoardWorkerClient & { dispose(): void } {
    const host: WorkerClient = createWorkerClient({
        name, protocol: 1, spawn: () => spawn(kind),
        events: ['pngPull', 'fontEpoch', 'memory'], eventLimit: 65_536, absoluteMs: 600_000,
        disposeResult: (_op, result) => closeWorkerResult(result),
    });
    const requests = new WeakMap<Promise<unknown>, { pending?: Promise<unknown>; retired: Promise<void> }>();
    const client: BoardWorkerClient & { dispose(): void } = {
        request<T>(op: string, payload: unknown, identity: BoardJobIdentity, options: RequestOptions,
            isCurrent: (identity: BoardJobIdentity) => boolean): Promise<T> {
            let pending: Promise<unknown> | undefined;
            const output = (async () => {
                if (!validBoardIdentity(identity)) throw new TypeError('Invalid board worker identity');
                const pinned = Object.freeze({ session: identity.session, epoch: identity.epoch, revision: identity.revision });
                if (!isCurrent(pinned)) throw new DOMException('Board job is stale', 'AbortError');
                pending = host.request(op, { identity: pinned, payload } satisfies BoardWorkerEnvelope<unknown>,
                    { ...options, deadlineMs: options.deadlineMs ?? defaultDeadline(kind), terminateOnDeadline: true });
                const result: unknown = await pending;
                if (!boardEnvelope(result) || !matchingIdentity(pinned, result.identity)) {
                    closeWorkerResult(result);
                    throw new TypeError('Invalid board worker reply identity');
                }
                try {
                    if (!isCurrent(pinned)) throw new DOMException('Board job is stale', 'AbortError');
                } catch (error) { closeWorkerResult(result); throw error; }
                return result.payload as T;
            })();
            if (pending) {
                const entry = { pending: pending as Promise<unknown> | undefined, retired: host.whenRetired(pending) };
                requests.set(output, entry);
                void output.then(() => { entry.pending = undefined; }, () => { entry.pending = undefined; });
            }
            return output;
        },
        whenRetired(request) { return requests.get(request)?.retired ?? Promise.resolve(); },
        reprioritise(request, priority) {
            const pending = requests.get(request)?.pending;
            if (pending) host.reprioritise(pending, priority);
        },
        on(event, handler) {
            return host.on(event, result => {
                if (!boardEnvelope(result)) { closeWorkerResult(result); return; }
                handler(result.payload, result.identity);
            });
        },
        cancelSession(session, epoch) {
            host.cancelAll((_op, args) => boardEnvelope(args) && args.identity.session === session && args.identity.epoch === epoch);
        },
        recycle: reason => host.recycle(reason, { lazy: true }),
        get state() { return host.state; },
        get inFlight() { return host.inFlight; },
        dispose: () => host.dispose(),
    };
    return client;
}
