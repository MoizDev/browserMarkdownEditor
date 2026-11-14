import type { MediaEntry } from '../model/media';
import type { BuildJob } from '../session/BoardSession';
import { exportIncrementalNotebookPdf } from './notebookExport';
import { pinNotebookExportWithMedia } from './notebookExportCapture';
import { createNativeNotebookIncrementalWriter } from './notebookIncrementalWriter';
import type { BoardRuntime } from './runtime';

/** Capture before returning the job; no document or filesystem lookup follows it. */
export function createIncrementalNotebookExportJob(options: {
    readonly runtime: BoardRuntime;
    readonly sourcePath: string;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly onError: (error: unknown) => void;
}): BuildJob & { release(): void } {
    const { runtime, sourcePath, readMedia, onError } = options;
    const pinned = pinNotebookExportWithMedia({ runtime, readMedia, onError });
    const lifetime = new AbortController();
    let released = false, started = false, running = false, pinReleased = false;
    const releasePin = () => { if (!pinReleased) { pinReleased = true; pinned.release(); } };
    const release = () => {
        if (released) return;
        released = true;
        lifetime.abort();
        // The active writer and its cancellation path may still be using the pin.
        if (!running) releasePin();
    };
    return {
        kind: 'build', revision: pinned.revision, release,
        async run(signal) {
            if (released || started) throw new Error('Notebook export job is no longer available');
            started = true; running = true;
            try {
                const active = AbortSignal.any([signal, lifetime.signal]);
                active.throwIfAborted();
                const writer = createNativeNotebookIncrementalWriter(pinned.revision, sourcePath);
                return await exportIncrementalNotebookPdf(pinned.snapshot, sourcePath, writer, active);
            } finally {
                running = false;
                try { release(); } finally { releasePin(); }
            }
        },
    };
}
