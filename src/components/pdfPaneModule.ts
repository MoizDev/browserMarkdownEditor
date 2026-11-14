export type PdfPaneComponent = typeof import('./PdfPane')['default'];

export type PdfPaneModuleSnapshot =
    | { readonly status: 'unloaded'; readonly attempt: 0 }
    | { readonly status: 'loading'; readonly attempt: number }
    | { readonly status: 'ready'; readonly attempt: number; readonly Component: PdfPaneComponent }
    | { readonly status: 'error'; readonly attempt: number; readonly error: unknown; readonly reloadRequired: boolean };

let snapshot: PdfPaneModuleSnapshot = Object.freeze({ status: 'unloaded', attempt: 0 });
let task: Promise<PdfPaneComponent> | undefined;
const listeners = new Set<() => void>();

export function getPdfPaneModuleSnapshot(): PdfPaneModuleSnapshot {
    return snapshot;
}

export function subscribePdfPaneModule(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function publish(next: PdfPaneModuleSnapshot): void {
    snapshot = Object.freeze(next);
    // Publish synchronously for a warm render; notify outside the import's
    // promise so a subscriber exception cannot turn a loaded module into error.
    for (const listener of [...listeners]) queueMicrotask(listener);
}

/** Measured: an already-prefetched PDF still waited 303ms to read (second: 3ms).
 * React.lazy owns a separate pending payload; a warm import is not a warm lazy
 * component. Keep its exact default here for direct rendering, not a wrapper. */
export function loadPdfPane(options: { retry?: boolean } = {}): Promise<PdfPaneComponent> {
    if (task && (snapshot.status !== 'error' || !options.retry)) return task;
    const attempt = snapshot.attempt + 1;
    const next = import('./PdfPane').then(
        module => {
            publish({ status: 'ready', attempt, Component: module.default });
            return module.default;
        },
        error => {
            // Browsers may cache a failed module. One explicit retry may work;
            // another rejection must explain reload instead of spinning forever.
            publish({ status: 'error', attempt, error, reloadRequired: attempt > 1 });
            throw error;
        },
    );
    // A loading subscriber may re-enter; retain the attempt before notifying it.
    task = next;
    publish({ status: 'loading', attempt });
    // Idle prefetch is quiet even for a fire-and-forget caller. The returned
    // attempt still rejects, and the snapshot exposes the error on demand.
    void next.catch(() => {});
    return next;
}
