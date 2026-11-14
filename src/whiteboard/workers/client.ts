import { createWorkerClient, type Priority, type RequestOptions, type WorkerClient } from '../../platform/workers';
import { boardEnvelope, closeWorkerResult, matchingIdentity, validBoardIdentity } from './protocol';
import type { BoardJobIdentity, BoardWorkerEnvelope } from './protocol';

export type SharedBoardWorker = 'parse' | 'geometry' | 'decode' | 'export';
export interface BoardWorkerClient {
    request<T>(op: string, payload: unknown, identity: BoardJobIdentity, options: RequestOptions,
        isCurrent: (identity: BoardJobIdentity) => boolean): Promise<T>;
    reprioritise(request: Promise<unknown>, priority: Priority): void;
    on(event: string, handler: (payload: unknown, identity: BoardJobIdentity) => void): () => void;
    cancelSession(session: string, epoch: number): void;
    recycle(reason: string): Promise<void>;
}
const clients = new Map<SharedBoardWorker, BoardWorkerClient>();
function spawn(kind: SharedBoardWorker): Worker {
    if (kind === 'parse') return new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    if (kind === 'geometry') return new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    if (kind === 'decode') return new Worker(new URL('../media/decode.worker.ts', import.meta.url), { type: 'module' });
    return new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
}
/** Import deadline: 30 seconds per 100 MB, with a ten-second minimum. */
export function importDeadline(byteLength: number): number {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new RangeError('Invalid import length');
    return Math.max(10_000, Math.ceil(byteLength * 30_000 / 100_000_000));
}
function defaultDeadline(kind: SharedBoardWorker): number {
    return kind === 'decode' ? 10_000 : kind === 'export' ? 60_000 : 120_000;
}
export function boardWorker(kind: SharedBoardWorker): BoardWorkerClient {
    const existing = clients.get(kind);
    if (existing) return existing;
    const host: WorkerClient = createWorkerClient({
        name: `whiteboard-${kind}`, protocol: 1, spawn: () => spawn(kind),
        events: ['pngPull', 'fontEpoch', 'memory'], eventLimit: 65_536, absoluteMs: 600_000,
        disposeResult: (_op, result) => closeWorkerResult(result),
    });
    const requests = new WeakMap<Promise<unknown>, Promise<unknown>>();
    const client: BoardWorkerClient = {
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
            if (pending) requests.set(output, pending);
            return output;
        },
        reprioritise(request, priority) {
            const pending = requests.get(request);
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
    };
    clients.set(kind, client);
    return client;
}
