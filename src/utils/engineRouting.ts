import { writeStoredValue } from './storage';
import { pdfEngineAvailableInBuild } from './pdfEngineAvailability';

export type CanvasEngineKind = 'drawing' | 'notebook' | 'pdfInk';
// Old stored engine preferences never select a removed implementation.
export type CanvasEngine = 'board';
export type PdfViewer = 'classic' | 'tiled';
export const AVAILABLE_CANVAS_ENGINES: readonly CanvasEngine[] = ['board'];
export const AVAILABLE_PDF_VIEWERS: readonly PdfViewer[] = pdfEngineAvailableInBuild() ? ['tiled'] : [];
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

/** Source admission decides editability; a missing PDF engine never selects a legacy engine. */
export function routeEngines(_nativeKind?: CanvasEngineKind) {
    const enabled = developerEnabled();
    const canvas = Object.fromEntries(CANVAS_KINDS.map(kind => [kind, {
        engine: 'board' as CanvasEngine,
        emergencyReadOnly: enabled && stored(emergencyKey(kind)) === 'true',
    }])) as Record<CanvasEngineKind, { engine: CanvasEngine; emergencyReadOnly: boolean }>;
    return { canvas, pdfViewer: 'tiled' as PdfViewer, platformLayer: true };
}
