export type PdfPageFailureKind = 'failed' | 'quarantined';
export interface PdfPageStatus {
    readonly state: 'idle' | 'drawing' | 'slow' | PdfPageFailureKind;
    readonly pending: number;
    readonly reason?: string;
}
interface Entry {
    pending: number;
    slow: boolean;
    failure?: { kind: PdfPageFailureKind; reason: string };
    timer?: ReturnType<typeof setTimeout>;
    snapshot: Readonly<PdfPageStatus>;
}
const IDLE: Readonly<PdfPageStatus> = Object.freeze({ state: 'idle', pending: 0 });
const MAX_ENTRIES = 10_000, SLOW_MS = 1000;
const documents = new Map<string, Map<number, Entry>>(), listeners = new Set<() => void>();
let entryCount = 0;

function validate(docKey: string, page: number): void {
    if (typeof docKey !== 'string' || !docKey || docKey.length > 2048 || !Number.isSafeInteger(page) || page < 0 || page >= 100_000) {
        throw new RangeError('Invalid PDF page status identity');
    }
}
function notify(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* One subscriber must not block the others. */ }
    }
}
function entryFor(docKey: string, page: number): Entry {
    validate(docKey, page);
    let group = documents.get(docKey), entry = group?.get(page);
    if (entry) return entry;
    if (entryCount >= MAX_ENTRIES) throw new RangeError('PDF page status capacity exceeded');
    if (!group) { group = new Map(); documents.set(docKey, group); }
    entry = { pending: 0, slow: false, snapshot: IDLE };
    group.set(page, entry); entryCount++;
    return entry;
}
function publish(docKey: string, page: number, entry: Entry): void {
    if (documents.get(docKey)?.get(page) !== entry) return;
    const state = entry.failure?.kind ?? (entry.pending ? entry.slow ? 'slow' : 'drawing' : 'idle');
    const reason = entry.failure?.reason;
    const old = entry.snapshot;
    if (old.state !== state || old.pending !== entry.pending || old.reason !== reason) {
        entry.snapshot = state === 'idle' ? IDLE : Object.freeze({ state, pending: entry.pending, ...(reason !== undefined ? { reason } : {}) });
        if (state === 'idle') {
            const group = documents.get(docKey)!;
            group.delete(page); entryCount--;
            if (!group.size) documents.delete(docKey);
        }
        notify();
    }
}

/** Called on dispatch, not enqueue. Each lease settles at most once. */
export function beginPdfPageWork(docKey: string, page: number): { finish(): void } {
    const entry = entryFor(docKey, page);
    if (!Number.isSafeInteger(entry.pending + 1)) throw new RangeError('Too many PDF page jobs');
    if (entry.pending++ === 0) {
        entry.slow = false;
        entry.timer = setTimeout(() => {
            entry.timer = undefined;
            if (documents.get(docKey)?.get(page) !== entry || !entry.pending) return;
            entry.slow = true; publish(docKey, page, entry);
        }, SLOW_MS);
    }
    publish(docKey, page, entry);
    let held = true;
    return { finish() {
        if (!held) return;
        held = false;
        if (documents.get(docKey)?.get(page) !== entry) return;
        entry.pending--;
        if (!entry.pending) {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = undefined; entry.slow = false;
        }
        publish(docKey, page, entry);
    } };
}
export function failPdfPage(docKey: string, page: number, kind: PdfPageFailureKind, reason: string): void {
    if (kind !== 'failed' && kind !== 'quarantined' || typeof reason !== 'string' || !reason || reason.length > 1024) throw new RangeError('Invalid PDF page failure');
    const entry = entryFor(docKey, page);
    if (entry.failure?.kind === 'quarantined' && kind === 'failed') return;
    entry.failure = { kind, reason }; publish(docKey, page, entry);
}
export function clearPdfPageFailure(docKey: string, page?: number): void {
    if (page !== undefined) {
        validate(docKey, page);
        const entry = documents.get(docKey)?.get(page);
        if (entry?.failure) { entry.failure = undefined; publish(docKey, page, entry); }
        return;
    }
    const group = documents.get(docKey);
    if (!group) return;
    for (const [index, entry] of [...group]) if (entry.failure) { entry.failure = undefined; publish(docKey, index, entry); }
}
export function getPdfPageStatus(docKey: string, page: number): Readonly<PdfPageStatus> {
    validate(docKey, page);
    return documents.get(docKey)?.get(page)?.snapshot ?? IDLE;
}
export function subscribePdfPageStatus(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function releasePdfPageStatus(docKey: string): void {
    const group = documents.get(docKey);
    if (!group) return;
    for (const entry of group.values()) if (entry.timer !== undefined) clearTimeout(entry.timer);
    entryCount -= group.size; documents.delete(docKey); notify();
}
