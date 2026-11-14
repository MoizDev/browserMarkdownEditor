import type { MediaId } from '../model/media';
import { compressClipboard, encodeClipboardNow, prepareInlineMedia, type ClipboardEnvelope } from './encode';
import type { CopySnapshot } from './snapshot';

interface HeldSnapshot { readonly snapshot: CopySnapshot; count: number }
interface Candidate { readonly held: HeldSnapshot; envelope: ClipboardEnvelope; readonly controller: AbortController }
export interface CachedClipboard {
    readonly snapshot: CopySnapshot;
    readonly encoded: string;
    readonly plain: string;
    readonly cacheOnly: boolean;
}
export interface ClipboardCopyHost {
    readMedia(id: MediaId, signal: AbortSignal): Promise<Blob | null>;
    /** Captures eligibility and an exact revision; it must refuse opaque deletions before clipboard write. */
    prepareCut(snapshot: CopySnapshot): () => void;
    duplicate(snapshot: CopySnapshot): Promise<void>;
    notice(message: string): void;
}

function release(held: HeldSnapshot): void {
    if (--held.count !== 0) return;
    for (const lease of held.snapshot.leases) lease.release();
}

/** One session-wide copy cache. A cache hit requires the immutable exact envelope,
 * not just the nonce; a cache-only marker additionally requires exact plain text. */
export class ClipboardCopy {
    private candidate: Candidate | null = null;
    private written: { held: HeldSnapshot; envelope: ClipboardEnvelope } | null = null;
    private disposed = false;
    constructor(private readonly host: ClipboardCopyHost) {}

    setSelection(snapshot: CopySnapshot | null): void {
        if (this.disposed) throw new Error('Clipboard cache is closed');
        this.dropCandidate();
        if (!snapshot) return;
        const held: HeldSnapshot = { snapshot, count: 1 };
        const controller = new AbortController();
        let envelope: ClipboardEnvelope;
        try { envelope = encodeClipboardNow(snapshot, new Map()); }
        catch (error) { release(held); throw error; }
        const candidate: Candidate = { held, controller, envelope };
        this.candidate = candidate;
        void prepareInlineMedia(snapshot, (id, signal) => this.host.readMedia(id, signal), controller.signal).then(inline => {
            controller.signal.throwIfAborted();
            if (this.candidate !== candidate) return;
            const next = encodeClipboardNow(snapshot, inline);
            candidate.envelope = next;
            return compressClipboard(snapshot, next, controller.signal).then(compressed => {
                if (this.candidate === candidate && !controller.signal.aborted) candidate.envelope = compressed;
            });
        }).catch(() => {
            // Copy still has the synchronous native records; missing bytes are resolved by hash on paste.
        });
    }

    match(encoded: string, plain: string): CachedClipboard | null {
        const entry = this.written;
        if (!entry || entry.envelope.encoded !== encoded || (entry.envelope.cacheOnly && entry.envelope.plain !== plain)) return null;
        return { snapshot: entry.held.snapshot, encoded, plain: entry.envelope.plain, cacheOnly: entry.envelope.cacheOnly };
    }

    copyEvent(event: ClipboardEvent, cut = false): boolean {
        const candidate = this.candidate;
        if (!candidate || !event.clipboardData) return false;
        let commitCut: (() => void) | undefined;
        try {
            if (cut && candidate.held.snapshot.skippedOpaque.length) throw new Error(`This version can't cut opaque content: ${candidate.held.snapshot.skippedOpaque.join(', ')}`);
            if (cut) commitCut = this.host.prepareCut(candidate.held.snapshot);
            const envelope = candidate.envelope;
            event.clipboardData.setData('text/plain', envelope.plain);
            event.clipboardData.setData('text/html', envelope.html);
            event.preventDefault();
            this.remember(candidate.held, envelope);
            if (envelope.cacheOnly) this.host.notice('This copy works only in this app window.');
            if (candidate.held.snapshot.skippedOpaque.length) this.host.notice(`This version can't copy: ${candidate.held.snapshot.skippedOpaque.join(', ')}`);
            commitCut?.();
            return true;
        } catch (error) {
            this.host.notice(error instanceof Error ? error.message : 'Could not copy selection.');
            return false;
        }
    }

    async copyMenu(cut = false): Promise<void> {
        const candidate = this.candidate;
        if (!candidate) throw new Error('Nothing selected');
        const held = candidate.held;
        held.count++;
        try {
            if (cut && held.snapshot.skippedOpaque.length) throw new Error(`This version can't cut opaque content: ${held.snapshot.skippedOpaque.join(', ')}`);
            const commitCut = cut ? this.host.prepareCut(held.snapshot) : undefined;
            const envelope = candidate.envelope;
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob([envelope.plain], { type: 'text/plain' }),
                'text/html': new Blob([envelope.html], { type: 'text/html' }),
            })]);
            if (this.disposed) return;
            this.remember(held, envelope);
            if (envelope.cacheOnly) this.host.notice('This copy works only in this app window.');
            if (held.snapshot.skippedOpaque.length) this.host.notice(`This version can't copy: ${held.snapshot.skippedOpaque.join(', ')}`);
            commitCut?.();
        } catch (error) {
            this.host.notice(error instanceof Error ? error.message : 'Could not copy selection.');
        } finally { release(held); }
    }

    async duplicate(): Promise<void> {
        const candidate = this.candidate;
        if (!candidate) throw new Error('Nothing selected');
        const held = candidate.held;
        held.count++;
        try {
            await this.host.duplicate(held.snapshot);
            if (held.snapshot.skippedOpaque.length) this.host.notice(`This version can't copy: ${held.snapshot.skippedOpaque.join(', ')}`);
        } finally { release(held); }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.dropCandidate();
        if (this.written) release(this.written.held);
        this.written = null;
    }

    private remember(held: HeldSnapshot, envelope: ClipboardEnvelope): void {
        held.count++;
        if (this.written) release(this.written.held);
        this.written = { held, envelope };
    }
    private dropCandidate(): void {
        if (!this.candidate) return;
        this.candidate.controller.abort();
        release(this.candidate.held);
        this.candidate = null;
    }
}
