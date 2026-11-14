import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { MediaId } from '../model/media';
import type { BoardRuntime } from '../host/runtime';
import { compressClipboard, encodeClipboardNow, prepareInlineMedia, type ClipboardEnvelope } from './encode';
import type { CopySnapshot } from './snapshot';

interface HeldSnapshot { readonly snapshot: CopySnapshot; readonly memory: { release(): void }; count: number }
interface Candidate { readonly held: HeldSnapshot; envelope: ClipboardEnvelope; readonly controller: AbortController; timer: ReturnType<typeof setTimeout> | null }
export interface CachedClipboard {
    readonly snapshot: CopySnapshot;
    readonly encoded: string;
    readonly plain: string;
    readonly cacheOnly: boolean;
    /** Source bytes remain behind their original session-owned media leases. */
    readMedia?(id: MediaId, signal: AbortSignal): Promise<Blob | null>;
}
export interface ClipboardCachePin {
    match(encoded: string, plain: string): CachedClipboard | null;
    release(): void;
}
export interface ClipboardCopyHost {
    readonly runtime: BoardRuntime;
    /** Shared session allocator; cache leases can outlive the originating pane. */
    readonly memory: MemoryAllocator;
    readMedia(id: MediaId, signal: AbortSignal): Promise<Blob | null>;
    isCurrent(snapshot: CopySnapshot): boolean;
    /** Captures eligibility and an exact revision; it must refuse opaque deletions before clipboard write. */
    prepareCut(snapshot: CopySnapshot): () => void;
    duplicate(snapshot: CopySnapshot): Promise<void>;
    notice(message: string): void;
}

function hold(snapshot: CopySnapshot, memory: MemoryAllocator): HeldSnapshot {
    const records = snapshot.payload.records.reduce((sum, line) => sum + line.length, 0);
    const media = snapshot.media.reduce((sum, item) => sum + item.bytes, 0);
    let text = 0, blocks = 0, runs = 0;
    for (const item of snapshot.textItems) for (const block of item.text.blocks) {
        blocks++;
        for (const run of block.runs) { runs++; text += run.text.length; }
    }
    // Over-limit records become a small marker, but the real text rendition still needs DOM and serialization memory.
    const portable = records <= 48 * 1024 * 1024;
    const bytes = Math.max(64 * 1024, (portable ? records * 8 : 0) + text * 8
        + snapshot.textItems.length * 512 + blocks * 384 + runs * 256 + (portable && media <= 32 * 1024 * 1024 ? media * 6 : 0));
    let reservation: ReturnType<MemoryAllocator['reserve']>;
    try { reservation = memory.reserve(bytes); }
    catch (error) { for (const lease of snapshot.leases) lease.release(); throw error; }
    if (!reservation) { for (const lease of snapshot.leases) lease.release(); throw new Error('Clipboard exceeds available memory'); }
    const retained = reservation;
    return { snapshot, memory: { release: () => memory.release(retained) }, count: 1 };
}
function release(held: HeldSnapshot): void {
    if (--held.count !== 0) return;
    try { for (const lease of held.snapshot.leases) lease.release(); } finally { held.memory.release(); }
}
function sameCapture(a: CopySnapshot, b: CopySnapshot): boolean {
    if (a.revision !== b.revision || a.payload.from.board !== b.payload.from.board || a.payload.from.sheet !== b.payload.from.sheet
        || a.payload.from.kind !== b.payload.from.kind || a.roots.length !== b.roots.length || a.selected.length !== b.selected.length
        || a.skippedOpaque.length !== b.skippedOpaque.length || a.payload.records.length !== b.payload.records.length
        || a.textItems.length !== b.textItems.length) return false;
    const x = a.textSelection, y = b.textSelection;
    if (!!x !== !!y || x && y && (x.node !== y.node || x.anchor !== y.anchor || x.focus !== y.focus)) return false;
    const equal = (p: readonly string[], q: readonly string[]) => p.every((value, index) => value === q[index]);
    if (!equal(a.roots, b.roots) || !equal(a.selected, b.selected) || !equal(a.skippedOpaque, b.skippedOpaque)
        || !equal(a.payload.records, b.payload.records)) return false;
    const boundsEqual = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number; w: number; h: number }) =>
        p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h;
    return boundsEqual(a.payload.bounds, b.payload.bounds) && a.textItems.every((item, index) => boundsEqual(item.bounds, b.textItems[index].bounds));
}
// Copy cache belongs to the window, not a pane; a vault switch must not invalidate its retained source.
let windowWritten: { held: HeldSnapshot; envelope: ClipboardEnvelope; readMedia: ClipboardCopyHost['readMedia']; controller: AbortController } | null = null;

/** One session-wide copy cache. A cache hit requires the immutable exact envelope,
 * not just the nonce; a cache-only marker additionally requires exact plain text. */
export class ClipboardCopy {
    private candidate: Candidate | null = null;
    private disposed = false;
    constructor(private readonly host: ClipboardCopyHost) {}

    setSelection(snapshot: CopySnapshot | null): void {
        if (this.disposed) throw new Error('Clipboard cache is closed');
        this.dropCandidate();
        if (!snapshot) return;
        const held = hold(snapshot, this.host.memory);
        const controller = new AbortController();
        let envelope: ClipboardEnvelope;
        try { envelope = encodeClipboardNow(snapshot, new Map()); }
        catch (error) { release(held); throw error; }
        const candidate: Candidate = { held, controller, envelope, timer: null };
        this.candidate = candidate;
        candidate.timer = setTimeout(() => {
        candidate.timer = null;
        if (this.candidate !== candidate || controller.signal.aborted) return;
        held.count++;
        try { void this.host.runtime.jobs.run(async context => {
            const inline = snapshot.payload.records.reduce((sum, line) => sum + line.length, 0) > 48 * 1024 * 1024
                ? new Map<MediaId, string>() : await prepareInlineMedia(snapshot, (id, signal) => this.host.readMedia(id, signal), context.signal);
            context.assertCurrent();
            if (this.candidate !== candidate || !this.host.isCurrent(snapshot)) return;
            const next = encodeClipboardNow(snapshot, inline);
            candidate.envelope = next;
            const compressed = await compressClipboard(snapshot, next, context.signal);
            context.assertCurrent();
            if (this.candidate === candidate && this.host.isCurrent(snapshot)) candidate.envelope = compressed;
        }, { signal: controller.signal, deadlineMs: 120_000 }).catch(() => {
            // Copy still has the synchronous native records; missing bytes are resolved by hash on paste.
        }).finally(() => release(held)); }
        catch { release(held); }
        }, 40);
    }

    match(encoded: string, plain: string): CachedClipboard | null {
        const entry = windowWritten;
        if (this.disposed || !entry || entry.envelope.encoded !== encoded || (entry.envelope.cacheOnly && entry.envelope.plain !== plain)) return null;
        return { snapshot: entry.held.snapshot, encoded, plain: entry.envelope.plain, cacheOnly: entry.envelope.cacheOnly, readMedia: entry.readMedia };
    }

    /** Pin the current window cache when a paste is queued, before a later copy can replace it. */
    pin(): ClipboardCachePin | null {
        const entry = windowWritten;
        if (this.disposed || !entry) return null;
        entry.held.count++;
        let active = true;
        return {
            match(encoded, plain) {
                if (!active || entry.envelope.encoded !== encoded || entry.envelope.cacheOnly && entry.envelope.plain !== plain) return null;
                return { snapshot: entry.held.snapshot, encoded, plain: entry.envelope.plain, cacheOnly: entry.envelope.cacheOnly,
                    async readMedia(id, signal) {
                        if (!active) throw new DOMException('Clipboard cache pin ended', 'AbortError');
                        entry.held.count++;
                        try { return await entry.readMedia(id, signal); }
                        finally { release(entry.held); }
                    } };
            },
            release() { if (active) { active = false; release(entry.held); } },
        };
    }

    /** The event path captures the current selection synchronously; it never waits for a warm cache. */
    copyEventNow(event: ClipboardEvent, capture: () => CopySnapshot, cut = false): boolean {
        if (!event.clipboardData || this.disposed) return false;
        try {
            const fresh = capture(), candidate = this.candidate;
            let transferred = false;
            try {
                if (candidate && this.host.isCurrent(candidate.held.snapshot) && sameCapture(candidate.held.snapshot, fresh)) {
                    for (const lease of fresh.leases) lease.release();
                    transferred = true;
                } else { transferred = true; this.setSelection(fresh); }
            } finally { if (!transferred) for (const lease of fresh.leases) lease.release(); }
        } catch (error) { this.host.notice(error instanceof Error ? error.message : 'Could not capture selection.'); return false; }
        return this.copyEvent(event, cut);
    }

    copyEvent(event: ClipboardEvent, cut = false): boolean {
        const candidate = this.candidate;
        if (!candidate || !event.clipboardData) return false;
        let commitCut: (() => void) | undefined;
        try {
            if (!this.host.isCurrent(candidate.held.snapshot)) throw new Error('Selection changed; copy again.');
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

    /** C2 capture is asynchronous, but ClipboardItem promises are installed during the initiating gesture. */
    async copyMenuFresh(capture: (signal: AbortSignal) => Promise<CopySnapshot>, cut = false): Promise<void> {
        if (this.disposed) throw new Error('Clipboard cache is closed');
        const runtime = this.host.runtime, controller = new AbortController(), session = runtime.session;
        let held: HeldSnapshot | undefined, finished = false;
        const prepared = runtime.jobs.run(async context => {
            const snapshot = await capture(context.signal);
            const owner = hold(snapshot, this.host.memory);
            if (finished || this.disposed) { release(owner); throw new DOMException('Clipboard capture ended', 'AbortError'); }
            held = owner; owner.count++;
            try {
            context.assertCurrent();
            if (runtime.session !== session || !this.host.isCurrent(snapshot)) throw new Error('Selection changed; copy again.');
            if (cut && snapshot.skippedOpaque.length) throw new Error(`This version can't cut opaque content: ${snapshot.skippedOpaque.join(', ')}`);
            const commitCut = cut ? this.host.prepareCut(snapshot) : undefined;
            let inline: ReadonlyMap<MediaId, string> = new Map();
            try {
                if (snapshot.payload.records.reduce((sum, line) => sum + line.length, 0) <= 48 * 1024 * 1024) {
                    inline = await prepareInlineMedia(snapshot, (id, signal) => this.host.readMedia(id, signal), context.signal);
                }
            }
            catch { context.assertCurrent(); }
            context.assertCurrent();
            if (finished || this.disposed || runtime.session !== session || !this.host.isCurrent(snapshot)) throw new DOMException('Clipboard capture became stale', 'AbortError');
            let envelope = encodeClipboardNow(snapshot, inline);
            try { envelope = await compressClipboard(snapshot, envelope, context.signal); }
            catch { context.assertCurrent(); }
            context.assertCurrent();
            if (finished || this.disposed || runtime.session !== session || !this.host.isCurrent(snapshot)) throw new DOMException('Clipboard capture became stale', 'AbortError');
            return { owner, envelope, commitCut };
            } finally { release(owner); }
        }, { signal: controller.signal, deadlineMs: 120_000 });
        const plain = prepared.then(value => new Blob([value.envelope.plain], { type: 'text/plain' }));
        const html = prepared.then(value => new Blob([value.envelope.html], { type: 'text/html' }));
        void plain.catch(() => undefined); void html.catch(() => undefined);
        try {
            await navigator.clipboard.write([new ClipboardItem({ 'text/plain': plain, 'text/html': html })]);
            const result = await prepared;
            if (this.disposed) return;
            this.remember(result.owner, result.envelope);
            if (result.envelope.cacheOnly) this.host.notice('This copy works only in this app window.');
            if (result.owner.snapshot.skippedOpaque.length) this.host.notice(`This version can't copy: ${result.owner.snapshot.skippedOpaque.join(', ')}`);
            result.commitCut?.();
        } catch (error) { this.host.notice(error instanceof Error ? error.message : 'Could not copy selection.'); }
        finally { finished = true; controller.abort(); if (held) release(held); }
    }

    async copyMenu(cut = false): Promise<void> {
        const candidate = this.candidate;
        if (!candidate) throw new Error('Nothing selected');
        const held = candidate.held;
        held.count++;
        try {
            if (!this.host.isCurrent(held.snapshot)) throw new Error('Selection changed; copy again.');
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
            if (!this.host.isCurrent(held.snapshot)) throw new Error('Selection changed; duplicate again.');
            await this.host.duplicate(held.snapshot);
            if (held.snapshot.skippedOpaque.length) this.host.notice(`This version can't copy: ${held.snapshot.skippedOpaque.join(', ')}`);
        } finally { release(held); }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.dropCandidate();

    }

    private remember(held: HeldSnapshot, envelope: ClipboardEnvelope): void {
        held.count++;
        if (windowWritten) { windowWritten.controller.abort(); release(windowWritten.held); }
        const controller = new AbortController(), blobs = new Map<MediaId, Blob>(), read = this.host.readMedia.bind(this.host);
        const entry = { held, envelope, controller, readMedia: async (id: MediaId, signal: AbortSignal) => {
            signal.throwIfAborted();
            return blobs.get(id) ?? await read(id, signal);
        } };
        windowWritten = entry;
        // A large asset prefetch must not queue a user paste behind a vault-sized read.
        if (held.snapshot.media.reduce((total, item) => total + item.bytes, 0) > 32 * 1024 * 1024) return;
        // Retain Blob references while the source is alive; no decoded pixels or whole-batch byte copies.
        held.count++;
        try { void this.host.runtime.jobs.run(async context => {
            for (const media of held.snapshot.media) {
                context.assertCurrent();
                if (windowWritten !== entry) break;
                const blob = await read(media.id, context.signal);
                context.assertCurrent();
                if (windowWritten !== entry) break;
                if (blob) blobs.set(media.id, new Blob([blob], { type: blob.type }));
            }
        }, { signal: controller.signal, deadlineMs: 120_000 }).catch(() => undefined).finally(() => release(held)); }
        catch { release(held); }
    }
    private dropCandidate(): void {
        if (!this.candidate) return;
        this.candidate.controller.abort();
        if (this.candidate.timer !== null) clearTimeout(this.candidate.timer);
        release(this.candidate.held);
        this.candidate = null;
    }
}
