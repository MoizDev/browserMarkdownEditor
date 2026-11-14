import type { DocumentSessionStore } from './documentSessions';

// C-01a wires App's exit guard and hidden-page checkpoint; W-10 registers the
// drawing, notebook and annotated-PDF serializers; C-14 drains before every
// flushTab caller. This store outlives panes and cached EditorStates.

export interface PendingSerializer {
    documentId: string; // OpenTab.id, not the path that a rename can change.
    hasPendingEdits(): boolean;
    flushPending(): void | Promise<void>;
}

interface Registration { serializer: PendingSerializer }

const registrations = new Map<string, Registration>();
const listeners = new Set<() => void>();
let drainQueue: Promise<void> = Promise.resolve();
let sessionBinding: { store: DocumentSessionStore; unsubscribe: () => void } | undefined;
const DRAIN_DEADLINE_MS = 2000;

function notifyPending(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch (error) { console.error('Pending-work subscriber failed:', error); }
    }
}

/** Bind the App-owned store; a stale StrictMode cleanup cannot remove its successor. */
export function installDocumentSessions(store: DocumentSessionStore): () => void {
    sessionBinding?.unsubscribe();
    const binding = { store, unsubscribe: store.subscribe(notifyPending) };
    sessionBinding = binding;
    notifyPending();
    return () => {
        if (sessionBinding !== binding) return;
        sessionBinding = undefined;
        binding.unsubscribe();
        notifyPending();
    };
}

/** Report in the first unserialised-change task, not in a later pane effect. */
export function registerPending(serializer: PendingSerializer): () => void {
    // The token is the registration, not the serializer: StrictMode may register
    // the very same reporter twice before its older cleanup runs.
    const { documentId } = serializer;
    const registration = { serializer };
    registrations.set(documentId, registration);
    notifyPending();
    return () => {
        if (registrations.get(documentId) !== registration) return;
        registrations.delete(documentId);
        notifyPending();
    };
}

/** Read synchronously by the exit guard; an unreadable reporter stays protected. */
export function anyPending(): boolean {
    try {
        for (const entry of sessionBinding?.store.entries() ?? []) {
            if (entry.hasPendingEdits()) return true;
        }
    } catch { return true; }
    for (const { serializer } of registrations.values()) {
        try {
            if (serializer.hasPendingEdits()) return true;
        } catch { return true; }
    }
    return false;
}

/** Start every current serializer before awaiting a PDF's asynchronous build. */
async function drainRegistered(documentId?: string): Promise<void> {
    const failures: unknown[] = [];
    const work: Promise<void>[] = [];
    for (const { serializer } of [...registrations.values()]) {
        if (documentId !== undefined && serializer.documentId !== documentId) continue;
        try {
            if (serializer.hasPendingEdits()) work.push(Promise.resolve(serializer.flushPending()));
        } catch (error) { failures.push(error); }
    }
    for (const entry of sessionBinding?.store.entries() ?? []) {
        if (documentId !== undefined && entry.documentId !== documentId) continue;
        try {
            if (entry.adapter.drain) work.push(Promise.resolve(entry.adapter.drain()));
        } catch (error) { failures.push(error); }
    }
    if (work.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const settled = Promise.allSettled(work).then(results => {
            for (const result of results) if (result.status === 'rejected') {
                if (timedOut) console.error('Document drain failed after its deadline:', result.reason);
                else failures.push(result.reason);
            }
        });
        await Promise.race([settled, new Promise<void>(resolve => {
            timer = setTimeout(() => { timedOut = true; resolve(); }, DRAIN_DEADLINE_MS);
        })]);
        if (timer !== undefined) clearTimeout(timer);
        if (timedOut) {
            console.warn('Document drain exceeded its deadline; pending work may be at risk.');
            for (const error of failures) console.error('Document drain failed:', error);
            failures.length = 0;
        }
    }
    notifyPending();
    if (failures.length) throw new AggregateError(failures, 'Could not drain pending document serializers.');
}

/** A second checkpoint re-reads the pending set after the first drain settles. */
function enqueueDrain(documentId?: string): Promise<void> {
    const run = drainQueue.then(() => drainRegistered(documentId));
    // A refused PDF drain must not poison the queue and prevent a later retry.
    drainQueue = run.catch(() => {});
    return run;
}

export function drainAll(): Promise<void> { return enqueueDrain(); }

/** Drain the current reporter for this document without draining other panes. */
export function drain(documentId: string): Promise<void> { return enqueueDrain(documentId); }

/** Registration, removal and completed drains synchronously notify subscribers. */
export function subscribePending(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
