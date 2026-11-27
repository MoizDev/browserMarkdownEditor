import { SECURITY_LIMITS } from './limits';
export { createImportAdmission } from './validatedImport';
export type { ImportAdmission, ImportData, ImportValidation, ProjectionLimits, ValidatedImport } from './validatedImport';

export interface ContentJob {
    readonly session: string;
    readonly vaultEpoch: number;
    readonly generation: number;
    readonly request: number;
}
export interface JobContext {
    readonly job: ContentJob;
    readonly signal: AbortSignal;
    assertCurrent(): void;
}
export interface JobOptions { readonly signal?: AbortSignal; readonly deadlineMs: number; }
export interface JobAuthority {
    run<T>(work: (context: JobContext) => Promise<T>, options: JobOptions): Promise<T>;
    isCurrent(job: ContentJob): boolean;
    assertContext(context: JobContext): void;
    replace(vaultEpoch: number, generation: number): void;
    drain(): Promise<void>;
    dispose(): void;
}
function visibleDeadline(ms: number, elapsed: () => void): () => void {
    const doc = typeof document === 'undefined' ? null : document;
    let left = ms, startedAt = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { startedAt = performance.now(); timer = setTimeout(fire, Math.min(left, 2147483647)); };
    const pause = () => { clearTimeout(timer); timer = undefined; left -= performance.now() - startedAt; };
    function fire() { doc?.removeEventListener('visibilitychange', change); elapsed(); }
    function change() {
        if (doc!.visibilityState === 'hidden') { if (timer !== undefined) pause(); }
        else if (timer === undefined) { if (left <= 0) fire(); else arm(); }
    }
    doc?.addEventListener('visibilitychange', change);
    if (!doc || doc.visibilityState !== 'hidden') arm();
    return () => { clearTimeout(timer); doc?.removeEventListener('visibilitychange', change); };
}
function validCounter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function cancelled(reason: string): DOMException { return new DOMException(reason, 'AbortError'); }

export function createJobAuthority(session: string, vaultEpoch: number, generation: number): JobAuthority {
    if (!session || session.length > 256 || !validCounter(vaultEpoch) || !validCounter(generation)) {
        throw new RangeError('Invalid session identity');
    }
    let epoch = vaultEpoch, currentGeneration = generation, request = 0, disposed = false;
    const outstanding = new Map<number, { job: ContentJob; controller: AbortController }>();
    let tail: Promise<void> = Promise.resolve(), activeContext: JobContext | null = null;
    function isCurrent(job: ContentJob): boolean {
        if (disposed || !job || typeof job !== 'object') return false;
        try {
            const prototype = Object.getPrototypeOf(job);
            if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(job).length !== 4) return false;
            const sessionField = Object.getOwnPropertyDescriptor(job, 'session');
            const epochField = Object.getOwnPropertyDescriptor(job, 'vaultEpoch');
            const generationField = Object.getOwnPropertyDescriptor(job, 'generation');
            const requestField = Object.getOwnPropertyDescriptor(job, 'request');
            if (!sessionField || !epochField || !generationField || !requestField
                || !('value' in sessionField) || !('value' in epochField) || !('value' in generationField) || !('value' in requestField)
                || sessionField.value !== session || epochField.value !== epoch || generationField.value !== currentGeneration
                || typeof requestField.value !== 'number' || !validCounter(requestField.value)) return false;
            const active = outstanding.get(requestField.value);
            // A value-equal clone is not the job object this authority issued.
            return !!active && active.job === job && !active.controller.signal.aborted;
        } catch { return false; }
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
            const stopDeadline = visibleDeadline(options.deadlineMs, () => controller.abort(cancelled('Content job deadline elapsed')));
            const assertCurrent = () => { if (!isCurrent(job)) throw cancelled('Stale or cancelled content job'); };
            const operation = tail.then(async () => {
                assertCurrent();
                const context: JobContext = Object.freeze({ job, signal: controller.signal, assertCurrent });
                activeContext = context;
                try {
                    const result = await work(context);
                    assertCurrent();
                    return result;
                } finally { activeContext = null; }
            });
            let rejectAbort!: (reason: unknown) => void;
            const abortReply = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
            const replyAbort = () => rejectAbort(controller.signal.reason ?? cancelled('Content job cancelled'));
            controller.signal.addEventListener('abort', replyAbort, { once: true });
            if (controller.signal.aborted) replyAbort();
            const settled = operation.finally(() => {
                stopDeadline();
                options.signal?.removeEventListener('abort', abort);
                controller.signal.removeEventListener('abort', replyAbort);
                outstanding.delete(job.request);
            });
            tail = settled.then(() => {}, () => {});
            return Promise.race([settled, abortReply]);
        },
        isCurrent,
        assertContext(context) {
            if (!activeContext || activeContext !== context || !isCurrent(context.job)) throw cancelled('Foreign, queued or ended content job context');
        },
        replace(nextEpoch, nextGeneration) {
            if (disposed || !validCounter(nextEpoch) || !validCounter(nextGeneration)) throw new RangeError('Invalid replacement identity');
            if (nextEpoch < epoch || (nextEpoch === epoch && nextGeneration <= currentGeneration)) throw new RangeError('Replacement identity must advance');
            abortAll('Session identity replaced');
            epoch = nextEpoch; currentGeneration = nextGeneration;
        },
        drain() { return tail; },
        dispose() { if (!disposed) { disposed = true; abortAll('Session closed'); } },
    };
}
