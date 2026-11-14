import type { PdfNativeEmphasisResult } from './pdfNativeEmphasis';

/** The caller supplies a byte-generation identity until its content hash is
 * ready. Profile fields describe paint, never the user's preference or zoom. */
export interface PdfEmphasisVerdictKey {
    bytes: string;
    page: number;
    algorithm: string;
    locale: string;
    planner: string;
    stroke: string;
    renderer: string;
    assets: string;
    intent: string;
    annotations: string;
    optionalContent: string;
    geometry: string;
    background: string;
    probe: string;
}
export type PdfEmphasisVerdictState =
    | { kind: 'unknown' }
    | { kind: 'queued' | 'probing' }
    | { kind: 'verified'; result: PdfNativeEmphasisResult }
    | { kind: 'unavailable'; reason: string; retryable: boolean };

type Entry = {
    state: PdfEmphasisVerdictState;
    listeners: Set<(state: PdfEmphasisVerdictState) => void>;
    consumers: number;
    controller?: AbortController;
    probe?: (signal: AbortSignal) => Promise<PdfNativeEmphasisResult>;
    work?: Promise<void>;
};
const encode = (key: PdfEmphasisVerdictKey) => JSON.stringify([
    key.bytes, key.page, key.algorithm, key.locale, key.planner, key.stroke,
    key.renderer, key.assets, key.intent, key.annotations, key.optionalContent,
    key.geometry, key.background, key.probe,
]);
const unknown: PdfEmphasisVerdictState = { kind: 'unknown' };

/** Small results outlive page cleanup. Canvas, page and render task are owned
 * only by the probe, and cancellation waits for that probe's own finally. */
export class PdfEmphasisVerdicts {
    private entries = new Map<string, Entry>();
    private disposed = false;
    private entry(key: PdfEmphasisVerdictKey): Entry {
        const id = encode(key);
        let entry = this.entries.get(id);
        if (!entry) {
            entry = { state: unknown, listeners: new Set(), consumers: 0 };
            this.entries.set(id, entry);
        }
        return entry;
    }
    getVerdict(key: PdfEmphasisVerdictKey): PdfEmphasisVerdictState {
        return this.entries.get(encode(key))?.state ?? unknown;
    }
    rejectPlan(key: PdfEmphasisVerdictKey, reason: 'renderer-version' | 'glyph-data' | 'page-budget'): void {
        const entry = this.entry(key);
        if (entry.state.kind === 'verified') this.publish(entry, { kind: 'unavailable', reason, retryable: false });
    }
    /** Preserve the in-flight entry, including its consumers, when the raw
     * hash becomes known. Never silently combine different live proofs. */
    promote(from: PdfEmphasisVerdictKey, to: PdfEmphasisVerdictKey): boolean {
        const oldId = encode(from), newId = encode(to);
        if (oldId === newId) return true;
        const entry = this.entries.get(oldId);
        if (!entry || this.entries.has(newId)) return false;
        // Keep the generation key as an alias for consumers that began before
        // hashing completed; both identities must coalesce on the same entry.
        this.entries.set(newId, entry);
        return true;
    }
    subscribe(key: PdfEmphasisVerdictKey, listener: (state: PdfEmphasisVerdictState) => void): () => void {
        const entry = this.entry(key);
        entry.listeners.add(listener);
        return () => { entry.listeners.delete(listener); };
    }
    ensureVerdict(key: PdfEmphasisVerdictKey, probe: (signal: AbortSignal) => Promise<PdfNativeEmphasisResult>): () => void {
        const entry = this.entry(key);
        if (this.disposed) return () => {};
        entry.consumers++;
        entry.probe = probe;
        this.start(entry);
        let held = true;
        return () => {
            if (!held) return;
            held = false;
            if (--entry.consumers === 0) entry.controller?.abort();
        };
    }
    private start(entry: Entry): void {
        if (!this.disposed && entry.consumers && entry.probe &&
            (entry.state.kind === 'unknown' || (entry.state.kind === 'unavailable' && entry.state.retryable)) && !entry.controller) {
            const probe = entry.probe;
            const controller = new AbortController();
            entry.controller = controller;
            this.publish(entry, { kind: 'queued' });
            entry.work = Promise.resolve().then(async () => {
                controller.signal.throwIfAborted();
                this.publish(entry, { kind: 'probing' });
                const result = await probe(controller.signal);
                controller.signal.throwIfAborted();
                this.publish(entry, { kind: 'verified', result: Object.freeze({ ...result }) });
            }).catch((error: unknown) => {
                if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
                    this.publish(entry, unknown);
                } else {
                    const reason = error instanceof Error ? error.message : 'PDF emphasis probe failed';
                    this.publish(entry, { kind: 'unavailable', reason,
                        retryable: !['renderer-version', 'glyph-data', 'page-budget'].includes(reason) });
                }
            }).finally(() => {
                if (entry.controller === controller) entry.controller = undefined;
                entry.work = undefined;
                // A StrictMode replay may subscribe while the old render is
                // still unwinding. Retry cancellation, not real failures.
                if (controller.signal.aborted) this.start(entry);
            });
        }
    }
    /** A foreground scale change must not wait behind a background proof.
     * Live consumers retain their watches and retry after the raster yields. */
    yieldProbes(): void {
        for (const entry of new Set(this.entries.values())) entry.controller?.abort();
    }
    async dispose(): Promise<void> {
        this.disposed = true;
        const work: Promise<void>[] = [];
        for (const entry of this.entries.values()) {
            entry.controller?.abort();
            if (entry.work) work.push(entry.work);
        }
        await Promise.all(work);
        this.entries.clear();
    }
    private publish(entry: Entry, state: PdfEmphasisVerdictState) {
        entry.state = state;
        for (const listener of entry.listeners) {
            try { listener(state); } catch (error) { console.error('PDF emphasis subscriber failed:', error); }
        }
    }
}
