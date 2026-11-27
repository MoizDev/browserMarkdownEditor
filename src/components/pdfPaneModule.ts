import { loadChunk } from '../platform/chunkLoad';

export type PdfPaneComponent = typeof import('./PdfPane')['default'];

export type PdfPaneModuleSnapshot =
    | { readonly status: 'unloaded'; readonly attempt: 0 }
    | { readonly status: 'loading'; readonly attempt: number }
    | { readonly status: 'ready'; readonly attempt: number; readonly Component: PdfPaneComponent }
    | { readonly status: 'error'; readonly attempt: number; readonly error: unknown; readonly reloadRequired: boolean };

let snapshot: PdfPaneModuleSnapshot = Object.freeze({ status: 'unloaded', attempt: 0 });
let task: Promise<PdfPaneComponent> | undefined;
let wanted = false;
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

export function loadPdfPane(options: { retry?: boolean; background?: boolean } = {}): Promise<PdfPaneComponent> {
    if (!options.background) wanted = true;
    if (task && (snapshot.status !== 'error' || !options.retry)) return task;
    const attempt = snapshot.attempt + 1;
    void loadChunk(() => import('./pdfSurfaceModules')).then(surfaces => surfaces.warmPdfOpenPath()).catch(() => {});
    const next = loadChunk(() => import('./PdfPane')).then(
        module => {
            publish({ status: 'ready', attempt, Component: module.default });
            return module.default;
        },
        error => {
            const shown = wanted;
            wanted = false;
            if (shown) publish({ status: 'error', attempt, error, reloadRequired: attempt > 1 });
            else { task = undefined; publish({ status: 'unloaded', attempt: 0 }); }
            throw error;
        },
    );
    task = next;
    publish({ status: 'loading', attempt });
    void next.catch(() => {});
    return next;
}
