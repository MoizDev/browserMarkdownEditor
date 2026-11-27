import { moduleSlot } from './moduleSlot';
import { loadChunk } from '../platform/chunkLoad';

export const pdfTiledSurfaceSlot = moduleSlot(() => import('./PdfTiledSurface'));
export const pdfTiledTextSurfaceSlot = moduleSlot(() => import('./PdfTiledTextSurface'));
export const nativePdfEntrySlot = moduleSlot(() => import('./whiteboard/NativePdfEntry'));

export function warmPdfOpenPath(): Promise<unknown> {
    return Promise.all([pdfTiledSurfaceSlot.load({ background: true }), loadChunk(() => import('../pdf/session/sourceRuntime')), loadChunk(() => import('../pdf/session/passwords')),
        loadChunk(() => import('../pdf/session/startup')).then(startup => startup.warmPdfEngine()), loadChunk(() => import('../platform/render/cpuEntry'))]);
}
