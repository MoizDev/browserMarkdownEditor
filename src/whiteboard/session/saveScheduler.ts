// Session-owned, not pane-owned: a pane can unmount while its document stays open.
// The callbacks synchronously pin and hand off the current revision; durable writes remain
// the save funnel's responsibility. A live gesture/composition is finished before flushNow.
export interface SaveSchedulerCallbacks {
    readonly flush: () => void;
    readonly finishGesture: () => void;
    readonly finishComposition: () => void;
    /** Synchronously pin changed encoded lines, returning the serialized append. */
    readonly captureJournal: () => () => void | Promise<void>;
    readonly journalError: (error: unknown) => void;
}

export interface SaveScheduler {
    /** A dirtying transaction has made at least one record newer than its handoff. */
    markDirty(): void;
    setGesture(active: boolean): void;
    setComposition(active: boolean): void;
    hasPendingEdits(): boolean;
    /** For hide, unmount, explicit save and reload: finish current input and hand it off now. */
    flushNow(): void;
    /** The session clears this only after the corresponding revision is durable. */
    setJournalPending(active: boolean): void;
    /** pagehide does not assemble or report a source. */
    pageHide(): void;
    /** Hidden documents journal immediately; a gesture keeps its normal flush hold. */
    hidden(): void;
    dispose(): void;
}

const DEBOUNCE_MS = 150;
const JOURNAL_MS = 500;

export function createSaveScheduler(callbacks: SaveSchedulerCallbacks): SaveScheduler {
    let dirty = false;
    let journalPending = false;
    let gesture = false;
    let composition = false;
    let disposed = false;
    let flushing = false;
    let queuedJournal: (() => void | Promise<void>) | undefined;
    let journalWork: Promise<void> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let journalTimer: ReturnType<typeof setTimeout> | undefined;

    function clearFlush(): void { clearTimeout(flushTimer); flushTimer = undefined; }
    function clearJournal(): void { clearTimeout(journalTimer); journalTimer = undefined; }
    function scheduleFlush(): void {
        clearFlush();
        if (!disposed && dirty && !gesture && !composition) {
            flushTimer = setTimeout(() => { flushTimer = undefined; flush(); }, DEBOUNCE_MS);
        }
    }
    function scheduleJournal(): void {
        if (!disposed && journalPending && journalTimer === undefined) {
            journalTimer = setTimeout(() => {
                journalTimer = undefined;
                journal();
                scheduleJournal();
            }, JOURNAL_MS);
        }
    }
    function drainJournal(): void {
        if (journalWork || !queuedJournal) return;
        const append = queuedJournal;
        queuedJournal = undefined;
        // The append is serialized, but capture was synchronous: hide/pagehide never waits for
        // a previous write before pinning its own data. Each snapshot covers the whole dirty set.
        journalWork = Promise.resolve().then(append).catch(error => callbacks.journalError(error)).finally(() => {
            journalWork = undefined;
            drainJournal();
        });
    }
    function journal(): void {
        if (disposed || !journalPending) return;
        try { queuedJournal = callbacks.captureJournal(); }
        catch (error) { callbacks.journalError(error); return; }
        drainJournal();
    }
    function flush(): void {
        if (disposed || !dirty || flushing) return;
        clearFlush();
        flushing = true;
        // Clear first: an edit made by the callback marks a new, independent batch dirty.
        dirty = false;
        try { callbacks.flush(); }
        catch (error) { dirty = true; throw error; }
        finally {
            flushing = false;
            if (dirty) scheduleFlush();
            scheduleJournal();
        }
    }
    return {
        markDirty() {
            if (disposed) return;
            dirty = true;
            journalPending = true;
            scheduleFlush();
            scheduleJournal();
        },
        setGesture(active) {
            if (disposed || gesture === active) return;
            gesture = active;
            scheduleFlush();
        },
        setComposition(active) {
            if (disposed || composition === active) return;
            composition = active;
            scheduleFlush();
        },
        hasPendingEdits() { return !disposed && (dirty || gesture || composition); },
        flushNow() {
            if (disposed) return;
            clearFlush();
            // Finish callbacks may synchronously publish final edits through markDirty.
            if (composition) { composition = false; callbacks.finishComposition(); }
            if (gesture) { gesture = false; callbacks.finishGesture(); }
            flush();
        },
        setJournalPending(active) {
            if (disposed) return;
            journalPending = active;
            if (active) scheduleJournal();
            else clearJournal();
        },
        pageHide() { journal(); },
        hidden() { journal(); },
        dispose() {
            if (disposed) return;
            disposed = true;
            clearFlush();
            clearJournal();
            // An already captured append remains queued even after the pane/session closes.
        },
    };
}
