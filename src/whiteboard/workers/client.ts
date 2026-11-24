import { createWorkerClient, type ClientState, type Priority, type RequestOptions, type WorkerClient } from '../../platform/workers';
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
    /** The host's state: `'failed'` refuses every request until its cool-down has passed and a request revives it. */
    readonly state: ClientState;
    /** Requests asked of the worker and not yet settled, every operation's. */
    readonly inFlight: number;
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
/** A legacy (tldraw-format) load's request ceiling, the board workers' own absolute cap. A stalled load is caught by the
 * worker host's progress watchdog instead (every slice heartbeats; 20 s of silence at priority 0 kills the worker), so
 * this only bounds work that keeps making progress. Sized by bytes, as before, it failed real boards for being large:
 * `max(30 s, 0.3 ms/KB)` ended a 1.04 MB, ~2,000-shape board at 30.6 s ("Worker request deadline elapsed"). */
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
/** Member `index` of a small pool of `kind` workers: member 0 is the shared worker (`boardWorker`), each other member a worker of
 * its own, made on its first request and ended by `endBoardWorkerPoolMember` once its user has no more work for it. */
export function boardWorkerPoolMember(kind: SharedBoardWorker, index: number): BoardWorkerClient {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid board worker pool member');
    if (index === 0) return boardWorker(kind);
    let pool = pools.get(kind);
    if (!pool) pools.set(kind, pool = []);
    return pool[index - 1] ??= createBoardWorkerClient(kind, `whiteboard-${kind}-pool-${index}`);
}
/** The state of pool member `index` without making it: `'idle'` for a member that is not running. */
export function boardWorkerPoolState(kind: SharedBoardWorker, index: number): ClientState {
    if (index === 0) return clients.get(kind)?.state ?? 'idle';
    return pools.get(kind)?.[index - 1]?.state ?? 'idle';
}
/** Ends idle pool member `index` (not the shared member 0), so its isolate and the garbage of its last requests go at once: an idle
 * isolate is seldom collected (see `dedicatedBoardWorker`). Its next request makes a new one. A member with a request in flight, or
 * one that has failed (its failure keeps it refused until its cool-down), is kept. */
export function endBoardWorkerPoolMember(kind: SharedBoardWorker, index: number): void {
    const pool = pools.get(kind), member = index > 0 ? pool?.[index - 1] : undefined;
    if (!pool || !member || member.inFlight || member.state === 'failed') return;
    pool[index - 1] = undefined;
    member.dispose();
}
let dedicatedSerial = 0;
/** A board worker of its own for one job, whose `dispose` ends the worker and so returns its whole heap at once. An old board's
 * import builds the file's text, its object graph and the board in the worker's heap, and the shared worker kept that garbage long
 * after the load was done, since an isolate that stops allocating is seldom collected (measured, a 10,060-stroke board: 255 MB held
 * from the end of its import until a collection happened to run 23 s later). */
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
