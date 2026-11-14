export type SessionReadiness = 'loading' | 'ready' | 'read-only' | 'failed';
export interface SessionMutationState { readonly state: SessionReadiness; readonly readOnlyReason: string | null }
export class SessionMutationRefused extends Error {
    constructor(readonly code: 'NOT_READY' | 'READ_ONLY' | 'DISPOSED', message: string) { super(message); this.name = 'SessionMutationRefused'; }
}
interface PendingMutation { run(): void; reject(reason: unknown): void; cleanup(): void }

// One queue belongs to the editing session, shared by input and agent callers. It serialises
// admission AFTER active gestures, not async tasks: the transaction itself must be synchronous.
export class GestureMutationQueue {
    private readonly pending: PendingMutation[] = [];
    private gestures = 0;
    private scheduled = false;
    private closed = false;
    constructor(private readonly readState: () => SessionMutationState) {}
    beginGesture(): () => void {
        if (this.closed) throw new SessionMutationRefused('DISPOSED', 'Session has been disposed');
        this.gestures++;
        let released = false;
        return () => {
            if (released) return;
            released = true; this.gestures--;
            this.schedule();
        };
    }
    afterGesture<T>(task: () => T, signal?: AbortSignal): Promise<T> {
        if (this.closed) return Promise.reject(new SessionMutationRefused('DISPOSED', 'Session has been disposed'));
        if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Mutation cancelled', 'AbortError'));
        return new Promise<T>((resolve, reject) => {
            const abort = () => {
                const index = this.pending.indexOf(item);
                if (index < 0) return;
                this.pending.splice(index, 1); item.cleanup();
                reject(signal?.reason ?? new DOMException('Mutation cancelled', 'AbortError'));
            };
            const item: PendingMutation = {
                reject,
                cleanup: () => signal?.removeEventListener('abort', abort),
                run: () => {
                    try {
                        this.guard(signal);
                        const value = task();
                        if (value !== null && (typeof value === 'object' || typeof value === 'function')
                            && typeof (value as { then?: unknown }).then === 'function') throw new TypeError('Session mutation tasks must be synchronous');
                        resolve(value);
                    } catch (error) { reject(error); }
                },
            };
            signal?.addEventListener('abort', abort, { once: true });
            this.pending.push(item); this.schedule();
        });
    }
    enqueue<T>(signal: AbortSignal, task: () => T): Promise<T> { return this.afterGesture(task, signal); }
    private guard(signal?: AbortSignal): void {
        if (this.closed) throw new SessionMutationRefused('DISPOSED', 'Session has been disposed');
        if (signal?.aborted) throw signal.reason ?? new DOMException('Mutation cancelled', 'AbortError');
        const current = this.readState();
        if (current.state === 'read-only' || current.readOnlyReason) throw new SessionMutationRefused('READ_ONLY', current.readOnlyReason ?? 'Document is read-only');
        if (current.state !== 'ready') throw new SessionMutationRefused('NOT_READY', `Document is ${current.state}`);
    }
    private schedule(): void {
        if (this.scheduled || this.closed || this.gestures || !this.pending.length) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (this.closed || this.gestures) return;
            const next = this.pending.shift();
            if (next) { next.cleanup(); next.run(); }
            this.schedule();
        });
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        const reason = new SessionMutationRefused('DISPOSED', 'Session has been disposed');
        for (const item of this.pending.splice(0)) { item.cleanup(); item.reject(reason); }
    }
}
