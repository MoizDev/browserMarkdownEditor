// Warm only the native panes the vault actually needs, after the app has drawn.
// Markdown-only vaults fetch none of the PDF, canvas or EPUB implementations.
import { loadPdfPane } from './pdfPaneModule';

export interface CanvasKinds {
    epub: boolean;
    pdf: boolean;
    drawing: boolean;
    nativeDrawing: boolean;
    notebook: boolean;
}

const started = new Set<string>();
function warm(key: string, load: () => Promise<unknown>): void {
    if (started.has(key)) return;
    started.add(key);
    // Demand owns the error and explicit Retry, not an idle refresh loop.
    load().catch(() => started.delete(key));
}

export function prefetchPanes(kinds: CanvasKinds): void {
    if (!kinds.epub && !kinds.pdf && !kinds.drawing && !kinds.nativeDrawing && !kinds.notebook) return;
    const run = () => {
        if (kinds.epub) warm('epub', () => import('./EpubPane'));
        if (kinds.pdf) warm('pdf', loadPdfPane);
        if (kinds.drawing || kinds.nativeDrawing || kinds.notebook) warm('canvas', () => import('./whiteboard/NativeCanvasEntry'));
    };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
}
