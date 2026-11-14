import { SECURITY_LIMITS } from './limits';

/** No path or vault handle crosses a decoder boundary. */
export interface ContentJob {
    readonly session: string;
    readonly vaultEpoch: number;
    readonly generation: number;
    readonly request: number;
}
export interface JobContext {
    readonly job: ContentJob;
    readonly signal: AbortSignal;
    /** Call after each await and synchronously immediately before committing a transaction. */
    assertCurrent(): void;
}
export interface JobOptions { readonly signal?: AbortSignal; readonly deadlineMs: number; }
export interface JobAuthority {
    run<T>(work: (context: JobContext) => Promise<T>, options: JobOptions): Promise<T>;
    isCurrent(job: ContentJob): boolean;
    /** A vault switch/reload revokes all outstanding requests, including same-path requests. */
    replace(vaultEpoch: number, generation: number): void;
    dispose(): void;
}
function validCounter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function cancelled(reason: string): DOMException { return new DOMException(reason, 'AbortError'); }

/** Session scope, not pane scope. Work must honor cancellation; keeping its promise in the tail
 * prevents a slow old job and its successor from mutating the session concurrently. */
export function createJobAuthority(session: string, vaultEpoch: number, generation: number): JobAuthority {
    if (!session || session.length > 256 || !validCounter(vaultEpoch) || !validCounter(generation)) {
        throw new RangeError('Invalid session identity');
    }
    let epoch = vaultEpoch, currentGeneration = generation, request = 0, disposed = false;
    const outstanding = new Map<number, { job: ContentJob; controller: AbortController }>();
    let tail: Promise<void> = Promise.resolve();
    function isCurrent(job: ContentJob): boolean {
        if (disposed || job.session !== session || job.vaultEpoch !== epoch || job.generation !== currentGeneration) return false;
        const active = outstanding.get(job.request);
        return !!active && !active.controller.signal.aborted && active.job.request === job.request;
    }
    function abortAll(reason: string): void {
        for (const entry of outstanding.values()) entry.controller.abort(cancelled(reason));
    }
    return {
        run<T>(work: (context: JobContext) => Promise<T>, options: JobOptions): Promise<T> {
            if (disposed) return Promise.reject(cancelled('Session is closed'));
            if (outstanding.size >= SECURITY_LIMITS.pendingJobs) return Promise.reject(new RangeError('Too many pending content jobs'));
            if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0 || !Number.isSafeInteger(request + 1)) {
                return Promise.reject(new RangeError('Invalid content job deadline or request counter'));
            }
            const job: ContentJob = Object.freeze({ session, vaultEpoch: epoch, generation: currentGeneration, request: ++request });
            const controller = new AbortController();
            outstanding.set(job.request, { job, controller });
            const abort = () => controller.abort(options.signal?.reason ?? cancelled('Content job cancelled'));
            options.signal?.addEventListener('abort', abort, { once: true });
            if (options.signal?.aborted) abort();
            const timer = setTimeout(() => controller.abort(cancelled('Content job deadline elapsed')), Math.min(options.deadlineMs, 2147483647));
            const assertCurrent = () => { if (!isCurrent(job)) throw cancelled('Stale or cancelled content job'); };
            const operation = tail.then(async () => {
                assertCurrent();
                const result = await work({ job, signal: controller.signal, assertCurrent });
                assertCurrent();
                return result;
            });
            let rejectAbort!: (reason: unknown) => void;
            const abortReply = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
            const replyAbort = () => rejectAbort(controller.signal.reason ?? cancelled('Content job cancelled'));
            controller.signal.addEventListener('abort', replyAbort, { once: true });
            if (controller.signal.aborted) replyAbort();
            const settled = operation.finally(() => {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', abort);
                controller.signal.removeEventListener('abort', replyAbort);
                outstanding.delete(job.request);
            });
            // A deadline settles the caller promptly but does not allow a later mutation to pass
            // a still-running uncooperative job. Its slot remains occupied until it actually ends.
            tail = settled.then(() => {}, () => {});
            return Promise.race([settled, abortReply]);
        },
        isCurrent,
        replace(nextEpoch, nextGeneration) {
            if (disposed || !validCounter(nextEpoch) || !validCounter(nextGeneration)) throw new RangeError('Invalid replacement identity');
            if (nextEpoch === epoch && nextGeneration <= currentGeneration) throw new RangeError('Replacement generation must advance');
            abortAll('Session identity replaced');
            epoch = nextEpoch; currentGeneration = nextGeneration;
        },
        dispose() { if (!disposed) { disposed = true; abortAll('Session closed'); } },
    };
}
