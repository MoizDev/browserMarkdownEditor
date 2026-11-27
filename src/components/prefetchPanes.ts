import { loadPdfPane } from './pdfPaneModule';
import { canvasPaneSlot, epubPaneSlot, nativeCanvasEntrySlot } from './paneModules';

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
    load().catch(() => started.delete(key));
}

export function prefetchPanes(kinds: CanvasKinds): void {
    if (!kinds.epub && !kinds.pdf && !kinds.drawing && !kinds.nativeDrawing && !kinds.notebook) return;
    const run = () => {
        const background = { background: true } as const;
        if (kinds.epub) warm('epub', () => epubPaneSlot.load(background));
        if (kinds.pdf) warm('pdf', () => loadPdfPane(background));
        if (kinds.drawing || kinds.nativeDrawing || kinds.notebook) warm('canvas', () => Promise.all([canvasPaneSlot.load(background), nativeCanvasEntrySlot.load(background)]));
    };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
}
