import type { SourceOwner } from '../../utils/documentBuffers';
import { ApplyFailed } from '../change/errors';

export interface SessionGestureQueueOptions {
    readonly owner: SourceOwner;
    readonly isCurrent: (owner: SourceOwner) => boolean;
    readonly isReadOnly: () => boolean;
}
export interface SessionGestureQueue {
    readonly isGestureActive: boolean;
    /** A gesture still in the person's hands (a contact down, an IME composition), as opposed to one only settling. */
    readonly isInputGestureActive: boolean;
    /** Admission/readiness and external I/O finish before enqueue. Task is synchronous. */
    enqueueAfterGesture<T>(signal: AbortSignal, task: () => T): Promise<T>;
    /** Pointer gesture/IME start. Release on EVERY end/cancel/flush path, idempotently. A `settling` hold is work the
     * person has already finished (an erase or a box after pointer-up, a commit awaiting its frame): it orders queued
     * edits and commands after it exactly like any hold, but does not refuse the person's next press. Take it BEFORE
     * releasing the gesture's own hold, so the queue never drains in between. */
    beginGesture(phase?: GesturePhase): () => void;
    /** Called when isGestureActive changes: commands disabled during a gesture re-read their state at its start and end. */
    subscribeGesture(listener: () => void): () => void;
    dispose(): void;
}
export type GesturePhase = 'input' | 'settling';
interface Pending {
    previous: Pending | null;
    next: Pending | null;
    linked: boolean;
    run(): void;
    cancel(error: unknown): void;
}

// C7.2/WB-D17: one session-owned FIFO shared by input and agent callers. Stop
// cancels while held; owner/read-only/cancellation are checked AGAIN just before
// the synchronous task. A microtask keeps edits outside apply's publication.
export function createSessionGestureQueue(options: SessionGestureQueueOptions): SessionGestureQueue {
    const owner = Object.freeze({ documentId: options.owner.documentId, session: options.owner.session });
    let first: Pending | null = null, last: Pending | null = null;
    let holds = 0, settling = 0, disposed = false, scheduled = false;
    const gestureListeners = new Set<() => void>();
    const gestureChanged = () => {
        for (const listener of [...gestureListeners]) {
            try { listener(); } catch (error) { queueMicrotask(() => { throw error; }); }
        }
    };
    const schedule = () => {
        if (!disposed && !holds && !scheduled && first) {
            scheduled = true;
            queueMicrotask(drain);
        }
    };
    // An aborted request must leave the FIFO immediately: a long gesture can
    // otherwise retain every cancelled agent/paste promise until pointer-up.
    function unlink(item: Pending): void {
        if (!item.linked) return;
        if (item.previous) item.previous.next = item.next;
        else first = item.next;
        if (item.next) item.next.previous = item.previous;
        else last = item.previous;
        item.previous = item.next = null;
        item.linked = false;
    }
    function drain(): void {
        scheduled = false;
        while (!disposed && !holds && first) {
            const item: Pending = first;
            unlink(item);
            item.run();
        }
        schedule();
    }
    const check = (signal: AbortSignal) => {
        if (signal.aborted) throw new DOMException('Canvas edit cancelled', 'AbortError');
        if (disposed || !options.isCurrent(owner)) throw new ApplyFailed('stale-session', 'The board session has ended');
        if (options.isReadOnly()) throw new ApplyFailed('read-only', 'The board is read-only');
    };
    return {
        get isGestureActive() { return holds > 0 && !disposed; },
        get isInputGestureActive() { return holds > settling && !disposed; },
        enqueueAfterGesture<T>(signal: AbortSignal, task: () => T): Promise<T> {
            let work: (() => T) | undefined = task;
            return new Promise<T>((resolve, reject) => {
                try { check(signal); }
                catch (error) { work = undefined; reject(error); return; }
                const clear = () => { work = undefined; unlink(item); signal.removeEventListener('abort', abort); };
                const item: Pending = {
                    previous: null, next: null, linked: false,
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
                    item.previous = last;
                    if (last) last.next = item;
                    else first = item;
                    last = item;
                    item.linked = true;
                    if (signal.aborted) abort();
                    schedule();
                } catch (error) { item.cancel(error); }
            });
        },
        beginGesture(phase = 'input') {
            if (disposed) throw new ApplyFailed('disposed', 'The board session has ended');
            let active = true;
            const release = () => {
                if (!active) return;
                active = false;
                if (!disposed) { holds--; if (phase === 'settling') settling--; schedule(); if (!holds) gestureChanged(); }
            };
            holds++; if (phase === 'settling') settling++;
            if (holds === 1) gestureChanged();
            return release;
        },
        subscribeGesture(listener) {
            gestureListeners.add(listener);
            return () => { gestureListeners.delete(listener); };
        },
        dispose() {
            if (disposed) return;
            const wasActive = holds > 0;
            disposed = true;
            while (first) first.cancel(new ApplyFailed('stale-session', 'The board session has ended'));
            if (wasActive) gestureChanged();
            gestureListeners.clear();
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
    get isInputGestureActive(): boolean { return this.queue.isInputGestureActive; }
    beginGesture(phase?: GesturePhase): () => void { return this.queue.beginGesture(phase); }
    subscribeGesture(listener: () => void): () => void { return this.queue.subscribeGesture(listener); }
    enqueueAfterGesture<T>(signal: AbortSignal, task: () => T): Promise<T> { return this.queue.enqueueAfterGesture(signal, task); }
    afterGesture<T>(task: () => T, signal: AbortSignal = uncancelled): Promise<T> { return this.enqueueAfterGesture(signal, task); }
    enqueue<T>(signal: AbortSignal, task: () => T): Promise<T> { return this.enqueueAfterGesture(signal, task); }
    dispose(): void { this.queue.dispose(); }
}
