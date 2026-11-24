// Which PDFs have a page turn pressed and not yet settled (written, with any Annotate owner rebuilt on the turned
// pages, or failed and rolled back). App holds it from the press (usePdfActions.rotatePdf) to that end.
//
// The turn is computed from the file and, when it lands, replaces the document's Annotate owner (app/pdfGestures.ts),
// so ink that reached the old-orientation board after the press had nowhere to go: a stroke drawn after ⌘E during a
// slow write was silently missing from the turned file, followed by "Board session ended" and, on the next ⌘E,
// "Conflicting PDF source identity" (review run, close() held 4 s). So while a turn is held no board takes ink: App
// queues a switch to Annotate here and makes it once the turn is released, on the turned pages (useTabLifecycle); the
// PDF pane presents Original whatever mode a tab arrives in; and the native host refuses every other writer (the agent).
// Ink drawn before the press is not affected: the turn saves it first (saveInkBeforeTurn).

const held = new Map<string, number>();
const queued = new Map<string, () => void>();
const listeners = new Set<() => void>();
function emit(): void { for (const listener of [...listeners]) { try { listener(); } catch { /* One observer cannot stop the others. */ } } }

/** Held until the returned release is called, once; presses nest. */
export function holdPdfTurn(documentId: string): () => void {
    held.set(documentId, (held.get(documentId) ?? 0) + 1);
    emit();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = (held.get(documentId) ?? 1) - 1;
        if (count > 0) held.set(documentId, count); else held.delete(documentId);
        const run = count > 0 ? undefined : queued.get(documentId);
        if (run) queued.delete(documentId);
        emit();
        try { run?.(); } catch (error) { console.error('Could not finish what waited for a PDF turn:', error); }
    };
}

/** Run `after` once the document's turn is released (now, when none is held); a later request replaces it. */
export function afterPdfTurn(documentId: string, after: () => void): void {
    if (!held.has(documentId)) { after(); return; }
    queued.set(documentId, after);
    emit();
}

/** Take back what waits for the document's turn; true when something was waiting. */
export function cancelAfterPdfTurn(documentId: string): boolean {
    const had = queued.delete(documentId);
    if (had) emit();
    return had;
}

export function pdfTurnQueued(documentId: string): boolean { return queued.has(documentId); }

export function pdfTurnHeld(documentId: string): boolean { return held.has(documentId); }

export function subscribePdfTurnHolds(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
