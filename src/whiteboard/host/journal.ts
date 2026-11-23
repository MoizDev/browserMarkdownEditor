import type { JournalCapture } from '../../utils/recoveryFunnel';
import type { ContentSource } from '../../utils/documentBuffers';
import type { SerializerPrime } from '../format/serializerProtocol';
import type { SampleStore } from '../ink/samples';
import type { BoardDoc } from '../model/doc';
import type { MediaEntry, MediaId } from '../model/media';
import type { BoardJournalPort } from '../session/factoryTypes';
import { createBoardRecoveryCapture } from './recoveryCapture';
import { recoverBoardJournal } from './recoveryReplay';
import { isCancellation } from '../../platform/workers/envelope';

// Provenance: C-20 journal transport, cumulative board recipe and transactional
// replay contracts; independent composition without third-party source.
export interface BoardJournalOptions {
    readonly capture: Parameters<typeof createBoardRecoveryCapture>[0];
    readonly doc: BoardDoc;
    readonly samples: SampleStore;
    readonly signal?: AbortSignal;
    append(capture: JournalCapture, source: ContentSource): Promise<void>;
    projectMedia?: (entry: MediaEntry) => MediaEntry;
    prepareMedia?: (payload: unknown, signal: AbortSignal, isCurrent: () => boolean) => Promise<{ readonly files: ReadonlyMap<MediaId, string>; release(): void }>;
    isCurrent?: () => boolean;
    /** App re-reads disk and compares its stat/hash with the session baseline. */
    assertDiskBaseline(signal: AbortSignal): Promise<void>;
    onError(error: unknown): void;
    cooperate?: () => Promise<void>;
}
export function createBoardJournal(options: BoardJournalOptions): BoardJournalPort & {
    acknowledge(revision: number, baseline?: SerializerPrime): void;
} {
    if (options.capture.doc !== options.doc) throw new TypeError('Journal capture must own the session document');
    const capture = createBoardRecoveryCapture(options.capture), controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let disposed = false, captureReleased = false, inFlight = 0, failure: unknown;
    let tail: Promise<void> = Promise.resolve(), replay: Promise<void> | undefined;
    let baselineBytes = options.capture.baseline.baseline;
    const report = (error: unknown) => { try { options.onError(error); } catch { /* Preserve the underlying failure. */ } };
    const releaseWhenIdle = () => {
        if (disposed && !inFlight && !replay && !captureReleased) { captureReleased = true; capture.dispose(); }
    };
    const enqueue = (snapshot: JournalCapture, source: ContentSource, barrier: Promise<void> | undefined): Promise<void> => {
        inFlight++;
        const task = tail.then(async () => {
            if (barrier) await barrier.catch(() => {});
            await options.append(snapshot, source);
        });
        // A superseded or cancelled append is not a failure: a later dirty batch journals the same content again.
        tail = task.then(() => {}, error => {
            if (isCancellation(error)) return;
            failure ??= error; report(error);
        });
        void tail.finally(() => { inFlight--; releaseWhenIdle(); });
        return task;
    };
    return {
        record(applied, revision) {
            if (disposed) throw new Error('Board journal disposed');
            // Recovery is itself one normal committed transaction. Keep its new
            // cumulative delta; only the transport waits until replay returns.
            capture.record(applied, revision);
        },
        capture(source, context) {
            if (disposed) throw new Error('Board journal disposed');
            const snapshot = capture.capture(context), barrier = replay;
            const lease = snapshot ? source.retain?.() : undefined;
            let pending: Promise<void> | undefined, cancelled = false;
            const append = () => {
                if (!snapshot || cancelled) return;
                return pending ??= enqueue(snapshot, source, barrier).finally(() => lease?.release());
            };
            append.cancel = () => { if (!pending && !cancelled) { cancelled = true; lease?.release(); } };
            return append;
        },
        delta(context) { return disposed ? undefined : capture.capture(context); },
        async recover(payload, apply) {
            if (disposed) throw new Error('Board journal disposed');
            if (replay) throw new Error('Board recovery is already in progress');
            signal.throwIfAborted();
            const revision = options.doc.rev, expectedBaseline = baselineBytes;
            const current = () => !disposed && !signal.aborted && options.doc.rev === revision && baselineBytes === expectedBaseline && (options.isCurrent?.() ?? true);
            const work = (async () => {
                if (!current()) throw new DOMException('Board recovery is no longer current', 'AbortError');
                const recipe = payload && typeof payload === 'object' ? payload as { prime?: { baseline?: unknown } } : undefined;
                const source = recipe?.prime?.baseline;
                if (!(source instanceof Blob) || (typeof File !== 'undefined' && source instanceof File) || source.size !== baselineBytes.size) {
                    throw new Error('Recovery baseline differs; save a copy instead');
                }
                // Compare the exact source in bounded chunks before staging media or model edits.
                for (let offset = 0; offset < baselineBytes.size; offset += 1024 * 1024) {
                    if (!current()) throw new DOMException('Board recovery is no longer current', 'AbortError');
                    const [left, right] = await Promise.all([
                        source.slice(offset, offset + 1024 * 1024).arrayBuffer(),
                        baselineBytes.slice(offset, offset + 1024 * 1024).arrayBuffer(),
                    ]);
                    if (!current()) throw new DOMException('Board recovery is no longer current', 'AbortError');
                    const a = new Uint8Array(left), b = new Uint8Array(right);
                    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error('Recovery baseline differs; save a copy instead');
                    await options.cooperate?.();
                }
                if (!current()) throw new DOMException('Board recovery is no longer current', 'AbortError');
                await options.assertDiskBaseline(signal);
                if (!current()) throw new DOMException('Board recovery is no longer current', 'AbortError');
                const media = await options.prepareMedia?.(payload, signal, current);
                try {
                    if (!current()) throw new DOMException('Board recovery is no longer current', 'AbortError');
                    await recoverBoardJournal(payload, { doc: options.doc, samples: options.samples, apply, signal,
                        cooperate: options.cooperate, projectMedia: options.projectMedia, mediaFiles: media?.files, isCurrent: current,
                        assertDiskBaseline: options.assertDiskBaseline });
                } finally { media?.release(); }
            })();
            replay = work;
            try { await work; }
            catch (error) { report(error); throw error; }
            finally { if (replay === work) replay = undefined; releaseWhenIdle(); }
        },
        acknowledge(revision: number, baseline?: SerializerPrime) {
            if (disposed) throw new Error('Board journal disposed');
            capture.acknowledge(revision, baseline);
            if (baseline) baselineBytes = baseline.baseline;
        },
        async drain() {
            // A recovery can enqueue its cumulative append only after replay commits.
            for (;;) {
                const currentReplay = replay, pending = tail;
                if (currentReplay) await currentReplay;
                await pending;
                if (!replay && pending === tail) break;
            }
            if (failure !== undefined) { const error = failure; failure = undefined; throw error; }
        },
        dispose() {
            if (disposed) return;
            disposed = true; controller.abort(); releaseWhenIdle();
        },
    };
}
