import { writeStoredValue } from './storage';

export type CanvasEngineKind = 'drawing' | 'notebook' | 'pdfInk';
<<<<<<< HEAD
export type CanvasEngine = 'tldraw' | 'viewer' | 'board';
export type PdfViewer = 'tiled';

// Add an engine here only when its host and lazy import are in this build.
// The same availability list drives the controls and the synchronous router.
export const AVAILABLE_CANVAS_ENGINES: readonly CanvasEngine[] = ['tldraw', 'board'];
// The lazy native host shares one admitted session with its editing services;
// source and per-view readiness still decide whether a particular file is editable.
const NATIVE_VIEWER_KINDS: readonly CanvasEngineKind[] = ['drawing', 'notebook'];
// Missing production engine assets fail closed in this host, never into an old parser.
export const AVAILABLE_PDF_VIEWERS: readonly PdfViewer[] = ['tiled'];
=======
// Old stored engine preferences never select a removed implementation.
export type CanvasEngine = 'board';
export type PdfViewer = 'classic' | 'tiled';
export const AVAILABLE_CANVAS_ENGINES: readonly CanvasEngine[] = ['board'];
export const AVAILABLE_PDF_VIEWERS: readonly PdfViewer[] = pdfEngineAvailableInBuild() ? ['tiled'] : [];
>>>>>>> feat/in-house-engines
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
<<<<<<< HEAD
    const canvas = Object.fromEntries(CANVAS_KINDS.map(kind => {
        const value = enabled ? stored(engineKey(kind)) : null;
        // Native data must never fall back to tldraw, even when developer
        // settings are off or its stored switch names a missing engine.
        const engine = kind === nativeKind
            ? AVAILABLE_CANVAS_ENGINES.find(candidate => candidate === 'board')
                ?? (NATIVE_VIEWER_KINDS.includes(kind) ? 'viewer' : undefined)
                ?? AVAILABLE_CANVAS_ENGINES.find(candidate => candidate === 'viewer') ?? 'unavailable'
            : AVAILABLE_CANVAS_ENGINES.find(candidate => candidate === value) ?? 'tldraw';
        return [kind, { engine, emergencyReadOnly: enabled && stored(emergencyKey(kind)) === 'true' }];
    })) as Record<CanvasEngineKind, { engine: CanvasEngine | 'unavailable'; emergencyReadOnly: boolean }>;
    const pdfValue = enabled ? stored('bme.pdf.viewer') : null;
    const pdfViewer = AVAILABLE_PDF_VIEWERS.find(candidate => candidate === pdfValue) ?? 'tiled';
    return { canvas, pdfViewer, platformLayer: enabled && PLATFORM_LAYER_AVAILABLE && stored('bme.pdf.platformLayer') === 'true' };
=======
    const canvas = Object.fromEntries(CANVAS_KINDS.map(kind => [kind, {
        engine: 'board' as CanvasEngine,
        emergencyReadOnly: enabled && stored(emergencyKey(kind)) === 'true',
    }])) as Record<CanvasEngineKind, { engine: CanvasEngine; emergencyReadOnly: boolean }>;
    return { canvas, pdfViewer: 'tiled' as PdfViewer, platformLayer: true };
>>>>>>> feat/in-house-engines
}
