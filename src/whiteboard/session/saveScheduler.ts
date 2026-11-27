export interface SaveSchedulerCallbacks {
    readonly flush: () => void;
    readonly finishGesture: () => void;
    readonly finishComposition: () => void;
    readonly captureJournal: () => (() => void | Promise<void>) & { cancel?: () => void };
    readonly journalError: (error: unknown) => void;
}

export interface SaveScheduler {
    markDirty(): void;
    setGesture(active: boolean): void;
    setComposition(active: boolean): void;
    hasPendingEdits(): boolean;
    flushNow(): void;
    flushCommitted(): void;
    setJournalPending(active: boolean): void;
    pageHide(): void;
    hidden(): void;
    drain(): Promise<void>;
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
    let queuedJournal: ((() => void | Promise<void>) & { cancel?: () => void }) | undefined;
    let journalWork: Promise<void> | undefined;
    let currentJournal: typeof queuedJournal;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let journalTimer: ReturnType<typeof setTimeout> | undefined;
    let lastJournal = -Infinity;

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
        currentJournal = append;
        journalWork = Promise.resolve().then(append).catch(error => callbacks.journalError(error)).finally(() => {
            journalWork = undefined;
            currentJournal = undefined;
            drainJournal();
        });
    }
    function journal(): void {
        if (disposed || !journalPending) return;
        lastJournal = performance.now();
        try {
            const next = callbacks.captureJournal();
            queuedJournal?.cancel?.();
            queuedJournal = next;
        } catch (error) { callbacks.journalError(error); return; }
        drainJournal();
    }
    function flush(): void {
        if (disposed || !dirty || flushing) return;
        clearFlush();
        flushing = true;
        // Clear first: an edit made by the callback marks a new, independent batch dirty.
        dirty = false;
        let handedOff = false;
        try { callbacks.flush(); handedOff = true; }
        catch (error) { dirty = true; throw error; }
        finally {
            flushing = false;
            if (dirty) scheduleFlush();
            if (handedOff) journalHandedOff();
            else scheduleJournal();
        }
    }
    function journalHandedOff(): void {
        if (disposed || !journalPending) return;
        if (performance.now() - lastJournal < JOURNAL_MS) { scheduleJournal(); return; }
        clearJournal();
        journal();
        scheduleJournal();
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
            if (composition) { composition = false; callbacks.finishComposition(); }
            if (gesture) { gesture = false; callbacks.finishGesture(); }
            flush();
        },
        flushCommitted() {
            if (disposed) return;
            clearFlush();
            flush();
        },
        setJournalPending(active) {
            if (disposed) return;
            journalPending = active;
            if (active) scheduleJournal();
            else {
                clearJournal();
                queuedJournal?.cancel?.();
                currentJournal?.cancel?.();
                queuedJournal = undefined;
            }
        },
        pageHide() { journal(); },
        hidden() { journal(); },
        async drain() {
            for (;;) {
                drainJournal();
                const work = journalWork;
                if (!work) return;
                await work;
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            clearFlush();
            clearJournal();
        },
    };
}
