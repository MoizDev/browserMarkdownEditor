import { writeStoredValue } from './storage';

export type CanvasEngineKind = 'drawing' | 'notebook' | 'pdfInk';
export type CanvasEngine = 'tldraw' | 'viewer' | 'board';
export type PdfViewer = 'classic' | 'tiled';

// Add an engine here only when its host and lazy import are in this build.
// The same availability list drives the controls and the synchronous router.
export const AVAILABLE_CANVAS_ENGINES: readonly CanvasEngine[] = ['tldraw'];
export const AVAILABLE_PDF_VIEWERS: readonly PdfViewer[] = ['classic'];
export const PLATFORM_LAYER_AVAILABLE = true;
export const CANVAS_KINDS: readonly CanvasEngineKind[] = ['drawing', 'notebook', 'pdfInk'];
export const engineKey = (kind: CanvasEngineKind) => `bme.whiteboard.engine.${kind}`;
export const emergencyKey = (kind: CanvasEngineKind) => `bme.whiteboard.emergencyReadOnly.${kind}`;

function stored(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}
export function developerEnabled(): boolean { return stored('bme.developer') === 'true'; }
let incrementalEditor: boolean | undefined;
export function incrementalEditorEnabled(): boolean { return incrementalEditor ??= stored('bme.editor.incremental') !== 'false'; }
export function setDeveloperSetting(key: string, value: string | boolean): boolean {
    const written = writeStoredValue(key, String(value));
    if (written && key === 'bme.editor.incremental') incrementalEditor = String(value) !== 'false';
    return written;
}

/** Read at open, not continuously: an already-mounted editor keeps its engine. */
export function routeEngines(nativeKind?: CanvasEngineKind) {
    const enabled = developerEnabled();
    const canvas = Object.fromEntries(CANVAS_KINDS.map(kind => {
        const value = enabled ? stored(engineKey(kind)) : null;
        // Native data must never fall back to tldraw, even when developer
        // settings are off or its stored switch names a missing engine.
        const engine = kind === nativeKind
            ? AVAILABLE_CANVAS_ENGINES.find(candidate => candidate === 'board')
                ?? AVAILABLE_CANVAS_ENGINES.find(candidate => candidate === 'viewer') ?? 'unavailable'
            : AVAILABLE_CANVAS_ENGINES.find(candidate => candidate === value) ?? 'tldraw';
        return [kind, { engine, emergencyReadOnly: enabled && stored(emergencyKey(kind)) === 'true' }];
    })) as Record<CanvasEngineKind, { engine: CanvasEngine | 'unavailable'; emergencyReadOnly: boolean }>;
    const pdfValue = enabled ? stored('bme.pdf.viewer') : null;
    const pdfViewer = AVAILABLE_PDF_VIEWERS.find(candidate => candidate === pdfValue) ?? 'classic';
    return { canvas, pdfViewer, platformLayer: enabled && PLATFORM_LAYER_AVAILABLE && stored('bme.pdf.platformLayer') === 'true' };
}
