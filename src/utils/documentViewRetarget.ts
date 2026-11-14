import { flushRecord, readRecord, scopedKey } from './storage';

const listeners = new Set<(from: string, to: string) => void>();
const recordKeys = ['fileScrollAnchors', 'collapsedHeadings', 'pdfViewPositions', 'canvasViewPositions'] as const;

export function subscribeDocumentViewRetarget(listener: (from: string, to: string) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Flush pending pane state before moving its exact vault-scoped record. */
export function retargetDocumentViewRecords(from: string, to: string): void {
    if (from === to) return;
    for (const listener of [...listeners]) {
        try { listener(from, to); } catch (error) { console.error('Document view retarget listener failed:', error); }
    }
    const oldKey = scopedKey(from), newKey = scopedKey(to);
    for (const key of recordKeys) {
        const record = readRecord<unknown>(key);
        if (!Object.hasOwn(record, oldKey)) continue;
        record[newKey] = record[oldKey];
        delete record[oldKey];
        flushRecord(key);
    }
}
