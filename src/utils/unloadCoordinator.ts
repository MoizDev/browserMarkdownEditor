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

function notifyPending(): void {
    for (const listener of listeners) listener();
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
    for (const { serializer } of registrations.values()) {
        try {
            if (serializer.hasPendingEdits()) return true;
        } catch { return true; }
    }
    return false;
}

/** Start every current serializer before awaiting a PDF's asynchronous build. */
async function drainRegistered(): Promise<void> {
    const failures: unknown[] = [];
    const work: Promise<void>[] = [];
    for (const { serializer } of [...registrations.values()]) {
        try {
            if (serializer.hasPendingEdits()) work.push(Promise.resolve(serializer.flushPending()));
        } catch (error) { failures.push(error); }
    }
    for (const result of await Promise.allSettled(work)) {
        if (result.status === 'rejected') failures.push(result.reason);
    }
    try { notifyPending(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Could not drain pending document serializers.');
}

/** A second checkpoint re-reads the pending set after the first drain settles. */
export function drainAll(): Promise<void> {
    const run = drainQueue.then(drainRegistered);
    // A refused PDF drain must not poison the queue and prevent a later retry.
    drainQueue = run.catch(() => {});
    return run;
}

/** Registration, removal and completed drains synchronously notify subscribers. */
export function subscribePending(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
