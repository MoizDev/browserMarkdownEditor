// The PDF pane's routes as module slots (see moduleSlot.ts): loaded in the PdfPane chunk, warmed with it.
import { moduleSlot } from './moduleSlot';

export const pdfTiledSurfaceSlot = moduleSlot(() => import('./PdfTiledSurface'));
export const pdfTiledTextSurfaceSlot = moduleSlot(() => import('./PdfTiledTextSurface'));
export const nativePdfEntrySlot = moduleSlot(() => import('./whiteboard/NativePdfEntry'));

/** Warms everything a first PDF open waits on, all at once: the Original surface and, from it, the source runtime, the
 * password store, the engine's startup and the platform's canvas entry. Measured cold (inv-f trace-cold), each of those
 * was requested only after the one before it had arrived and run: surface at 20 ms, source modules at 310 ms, engine
 * files at 325 ms, cpuEntry at 396 ms, first tiles at 470 ms. Idempotent: every import is the module cache's. */
export function warmPdfOpenPath(): Promise<unknown> {
    // A failure is not reported here: the open that needs the module imports it again and owns the error.
    return Promise.all([pdfTiledSurfaceSlot.load(), import('../pdf/session/sourceRuntime'), import('../pdf/session/passwords'),
        import('../pdf/session/startup').then(startup => startup.warmPdfEngine()), import('../platform/render/cpuEntry')]);
}
