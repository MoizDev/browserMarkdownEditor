import type { SourceOwner } from '../../utils/documentBuffers';
import { ApplyFailed } from '../change/errors';

export interface SessionGestureQueueOptions {
    readonly owner: SourceOwner;
    readonly isCurrent: (owner: SourceOwner) => boolean;
    readonly isReadOnly: () => boolean;
}
export interface SessionGestureQueue {
    readonly isGestureActive: boolean;
    /** Admission/readiness and external I/O finish before enqueue. Task is synchronous. */
    enqueueAfterGesture<T>(signal: AbortSignal, task: () => T): Promise<T>;
    /** Pointer gesture/IME start. Release on EVERY end/cancel/flush path, idempotently. */
    beginGesture(): () => void;
    dispose(): void;
}
interface Pending { run(): void; cancel(error: unknown): void }

// C7.2/WB-D17: one session-owned FIFO shared by input and agent callers. Stop
// cancels while held; owner/read-only/cancellation are checked AGAIN just before
// the synchronous task. A microtask keeps edits outside apply's publication.
export function createSessionGestureQueue(options: SessionGestureQueueOptions): SessionGestureQueue {
    const owner = Object.freeze({ documentId: options.owner.documentId, session: options.owner.session });
    const pending: Pending[] = [];
    let holds = 0, disposed = false, scheduled = false;
    const schedule = () => {
        if (!disposed && !holds && !scheduled && pending.length) {
            scheduled = true;
            queueMicrotask(drain);
        }
    };
    function drain(): void {
        scheduled = false;
        let index = 0;
        while (!disposed && !holds && index < pending.length) pending[index++].run();
        if (index) pending.splice(0, index);
        schedule();
    }
    const check = (signal: AbortSignal) => {
        if (signal.aborted) throw new DOMException('Canvas edit cancelled', 'AbortError');
        if (disposed || !options.isCurrent(owner)) throw new ApplyFailed('stale-session', 'The board session has ended');
        if (options.isReadOnly()) throw new ApplyFailed('read-only', 'The board is read-only');
    };
    return {
        get isGestureActive() { return holds > 0 && !disposed; },
        enqueueAfterGesture<T>(signal: AbortSignal, task: () => T): Promise<T> {
            let work: (() => T) | undefined = task;
            return new Promise<T>((resolve, reject) => {
                try { check(signal); }
                catch (error) { work = undefined; reject(error); return; }
                const clear = () => { work = undefined; signal.removeEventListener('abort', abort); };
                const item: Pending = {
                    run() {
                        if (!work) return;
                        const run = work;
                        clear();
                        try {
                            check(signal);
                            const value = run();
                            if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) throw new ApplyFailed('async-agent-task', 'Queued canvas edits must be synchronous');
                            resolve(value);
                        } catch (error) { reject(error); }
                    },
                    cancel(error) { if (work) { clear(); reject(error); } },
                };
                function abort() { item.cancel(new DOMException('Canvas edit cancelled', 'AbortError')); }
                try {
                    signal.addEventListener('abort', abort, { once: true });
                    pending.push(item);
                    if (signal.aborted) abort();
                    schedule();
                } catch (error) { item.cancel(error); }
            });
        },
        beginGesture() {
            if (disposed) throw new ApplyFailed('disposed', 'The board session has ended');
            let active = true;
            const release = () => {
                if (!active) return;
                active = false;
                if (!disposed) { holds--; schedule(); }
            };
            holds++;
            return release;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const item of pending) item.cancel(new ApplyFailed('stale-session', 'The board session has ended'));
            pending.length = 0;
        },
    };
}

export type SessionReadiness = 'loading' | 'ready' | 'read-only' | 'failed';
export interface SessionMutationState { readonly state: SessionReadiness; readonly readOnlyReason: string | null }
export class SessionMutationRefused extends Error {
    constructor(readonly code: 'NOT_READY' | 'READ_ONLY' | 'DISPOSED', message: string) { super(message); this.name = 'SessionMutationRefused'; }
}
const uncancelled = new AbortController().signal;

// Preserve the viewer's class-shaped port while sharing ONE implementation.
// Ownership is mandatory: readiness alone cannot recognize a replaced session.
export class GestureMutationQueue implements SessionGestureQueue {
    private readonly queue: SessionGestureQueue;
    constructor(readState: () => SessionMutationState, ownership: Pick<SessionGestureQueueOptions, 'owner' | 'isCurrent'>) {
        this.queue = createSessionGestureQueue({ ...ownership,
            isCurrent: owner => {
                const current = readState();
                if (current.state === 'read-only' || current.readOnlyReason) throw new SessionMutationRefused('READ_ONLY', current.readOnlyReason ?? 'Document is read-only');
                if (current.state !== 'ready') throw new SessionMutationRefused('NOT_READY', `Document is ${current.state}`);
                return ownership.isCurrent(owner);
            },
            isReadOnly: () => false, // Checked with readiness above, in the same admission guard.
        });
    }
    get isGestureActive(): boolean { return this.queue.isGestureActive; }
    beginGesture(): () => void { return this.queue.beginGesture(); }
    enqueueAfterGesture<T>(signal: AbortSignal, task: () => T): Promise<T> { return this.queue.enqueueAfterGesture(signal, task); }
    afterGesture<T>(task: () => T, signal: AbortSignal = uncancelled): Promise<T> { return this.enqueueAfterGesture(signal, task); }
    enqueue<T>(signal: AbortSignal, task: () => T): Promise<T> { return this.enqueueAfterGesture(signal, task); }
    dispose(): void { this.queue.dispose(); }
}
