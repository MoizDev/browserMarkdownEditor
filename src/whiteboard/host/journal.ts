import type { JournalCapture } from '../../utils/recoveryFunnel';
import type { ContentSource } from '../../utils/documentBuffers';
import type { SerializerPrime } from '../format/serializerProtocol';
import type { SampleStore } from '../ink/samples';
import type { BoardDoc } from '../model/doc';
import type { MediaEntry } from '../model/media';
import type { BoardJournalPort } from '../session/factoryTypes';
import { createBoardRecoveryCapture } from './recoveryCapture';
import { recoverBoardJournal } from './recoveryReplay';

// Provenance: C-20 journal transport, cumulative board recipe and transactional
// replay contracts; independent composition without third-party source.
export interface BoardJournalOptions {
    readonly capture: Parameters<typeof createBoardRecoveryCapture>[0];
    readonly doc: BoardDoc;
    readonly samples: SampleStore;
    readonly signal?: AbortSignal;
    append(capture: JournalCapture, source: ContentSource): Promise<void>;
    projectMedia?: (entry: MediaEntry) => MediaEntry;
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
        tail = task.then(() => {}, error => { failure ??= error; report(error); });
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
        capture(source) {
            if (disposed) throw new Error('Board journal disposed');
            const snapshot = capture.capture(), barrier = replay;
            let pending: Promise<void> | undefined;
            return () => {
                if (!snapshot) return;
                return pending ??= enqueue(snapshot, source, barrier);
            };
        },
        delta() { return disposed ? undefined : capture.capture(); },
        async recover(payload, apply) {
            if (disposed) throw new Error('Board journal disposed');
            if (replay) throw new Error('Board recovery is already in progress');
            signal.throwIfAborted();
            const work = recoverBoardJournal(payload, { doc: options.doc, samples: options.samples, apply, signal,
                cooperate: options.cooperate, projectMedia: options.projectMedia });
            replay = work;
            try { await work; }
            catch (error) { report(error); throw error; }
            finally { if (replay === work) replay = undefined; releaseWhenIdle(); }
        },
        acknowledge(revision: number, baseline?: SerializerPrime) {
            if (disposed) throw new Error('Board journal disposed');
            capture.acknowledge(revision, baseline);
        },
        async drain() {
            // Include appends enqueued while an earlier append was in flight.
            for (;;) {
                const pending = tail;
                await pending;
                if (pending === tail) break;
            }
            if (failure !== undefined) { const error = failure; failure = undefined; throw error; }
        },
        dispose() {
            if (disposed) return;
            disposed = true; controller.abort(); releaseWhenIdle();
        },
    };
}
