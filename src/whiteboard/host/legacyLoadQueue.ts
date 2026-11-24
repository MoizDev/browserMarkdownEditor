// Admission for reading old-format (tldraw JSON) boards, notebooks and annotated PDFs into a board: one legacy load at a time,
// first come first served, except that a document a pane is showing goes ahead of ones nobody is looking at.
//
// A legacy load's working memory is the parse worker's JS heap (the JSON text, its object graph, the board it builds), not
// raster cache, so it is not charged to the render platform's CPU raster pool. It used to be: 16 MiB + 12 × the file size
// against a pool whose target is 32 MiB with no other canvas visible, so every old board over 1.33 MiB was refused outright,
// waited 60 s and failed with "Close another board" while nothing else held memory (measured: a 1.6 MB board, 60.4 s), and
// two or three ordinary boards restored together starved each other the same way. Serializing bounds that heap to one load's
// peak instead, and nothing about a legacy load trims another pane or steps display quality down.
// Every load waiting here ends, because the one running always gives the slot back: its worker steps are bounded by the
// worker's progress watchdog, its file reads by a deadline (legacyAcquisition.ts), and an abort releases the slot at once
// instead of waiting for the abandoned load to notice. Without the last two, one picture file that never arrived (a cloud
// placeholder) held the only slot for the page: that board said "Opening drawing…" and every other old board, notebook and
// annotated PDF "waiting for another document to finish opening…", for good, with no error and so no Try again.

/** The largest legacy board the importer reads (the worker's LEGACY_SCAN_MAX_BYTES), refused at once rather than queued.
 * With the raster-pool reservation gone this is the load's only size gate, so its cost was measured (peak resident memory
 * of the page's process over its idle level, one board opened alone, production build): 23 MB with 6 inline photos +442 MB
 * in 4.6 s; 102 MB with 28 photos +858 MB in 19 s; 200 MB with 55 photos +1,285 MB in 37 s — about 6–8 × the file for
 * picture boards, and the largest admitted file opens without the tab failing. */
export const LEGACY_LOAD_MAX_BYTES = 256 * 1024 * 1024;

export type LegacyLoadPhase = 'waiting' | 'loading';

interface Waiter { readonly key: string; readonly order: number; readonly urgent: boolean; start(): void }

const waiting = new Set<Waiter>();
/** Each admission's phase by document; two panes, or a paste, can each hold one for the same document. */
const phases = new Map<string, Map<object, LegacyLoadPhase>>();
const listeners = new Set<() => void>();
const shown = new Map<string, number>();
let running = 0, serial = 0;

function setPhase(key: string, token: object, phase: LegacyLoadPhase | null): void {
    let entries = phases.get(key);
    if (phase) { if (!entries) phases.set(key, entries = new Map()); entries.set(token, phase); }
    else if (entries) { entries.delete(token); if (!entries.size) phases.delete(key); }
    for (const listener of [...listeners]) listener();
}

function pump(): void {
    const rank = (waiter: Waiter) => waiter.urgent || (shown.get(waiter.key) ?? 0) > 0 ? 0 : 1;
    while (running < 1 && waiting.size) {
        let next: Waiter | undefined;
        for (const waiter of waiting) {
            if (!next || rank(waiter) < rank(next) || (rank(waiter) === rank(next) && waiter.order < next.order)) next = waiter;
        }
        waiting.delete(next!);
        running++;
        next!.start();
    }
}

/** A pane showing `key` (a document id) marks it, so its legacy load is admitted before hidden ones. Returns the unmark. */
export function showLegacyLoadTarget(key: string): () => void {
    shown.set(key, (shown.get(key) ?? 0) + 1);
    let live = true;
    return () => {
        if (!live) return;
        live = false;
        const left = (shown.get(key) ?? 1) - 1;
        if (left > 0) shown.set(key, left); else shown.delete(key);
    };
}

/** Where `key`'s legacy load is, for what its pane says, or null when none waits or runs. */
export function legacyLoadPhase(key: string): LegacyLoadPhase | null {
    const entries = phases.get(key);
    if (!entries) return null;
    for (const phase of entries.values()) if (phase === 'loading') return phase;
    return 'waiting';
}

export function subscribeLegacyLoadPhase(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Waits for this legacy load's turn and returns its release. Refuses at once a size the importer can never read.
 * `urgent` is a load the person is waiting on that no pane marks as shown (a paste into the board in front of them):
 * keyed by its own job, it ranked behind every old board still loading in a hidden pane and ran out its deadline. */
export async function admitLegacyLoad(options: { key: string; bytes?: number; signal: AbortSignal; urgent?: boolean }): Promise<() => void> {
    const { key, signal } = options;
    signal.throwIfAborted();
    if (options.bytes !== undefined && options.bytes > LEGACY_LOAD_MAX_BYTES) {
        const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
        throw new RangeError(`This file is ${mb(options.bytes)} MB; tldraw-format files larger than ${mb(LEGACY_LOAD_MAX_BYTES)} MB cannot be opened.`);
    }
    const token = {};
    setPhase(key, token, 'waiting');
    try {
        await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { key, order: ++serial, urgent: options.urgent === true, start: () => { signal.removeEventListener('abort', abort); resolve(); } };
            function abort() { waiting.delete(waiter); reject(signal.reason ?? new DOMException('Legacy load cancelled', 'AbortError')); }
            signal.addEventListener('abort', abort, { once: true });
            waiting.add(waiter);
            pump();
        });
    } catch (error) { setPhase(key, token, null); throw error; }
    setPhase(key, token, 'loading');
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener('abort', release);
        running--;
        setPhase(key, token, null);
        pump();
    };
    // The abandoned load's worker job is cancelled by the same signal and stops at its next slice, so the overlap with
    // the next load is one slice of one job, not two whole peaks.
    signal.addEventListener('abort', release, { once: true });
    return release;
}
