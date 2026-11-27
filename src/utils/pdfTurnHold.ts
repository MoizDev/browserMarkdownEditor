const held = new Map<string, number>();
const queued = new Map<string, () => void>();
const listeners = new Set<() => void>();
function emit(): void { for (const listener of [...listeners]) { try { listener(); } catch { /* One observer cannot stop the others. */ } } }

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

export function afterPdfTurn(documentId: string, after: () => void): void {
    if (!held.has(documentId)) { after(); return; }
    queued.set(documentId, after);
    emit();
}

export function cancelAfterPdfTurn(documentId: string): boolean {
    const had = queued.delete(documentId);
    if (had) emit();
    return had;
}

export function pdfTurnQueued(documentId: string): boolean { return queued.has(documentId); }

export function pdfTurnHeld(documentId: string): boolean { return held.has(documentId); }

export function pdfTurnSettled(documentId: string): Promise<void> {
    if (!held.has(documentId)) return Promise.resolve();
    return new Promise(resolve => {
        const stop = subscribePdfTurnHolds(() => { if (!held.has(documentId)) { stop(); resolve(); } });
    });
}

export function subscribePdfTurnHolds(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
