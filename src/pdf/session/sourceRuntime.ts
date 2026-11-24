import type { PdfTiledSourceFactory } from './hostTypes';

let factory: PdfTiledSourceFactory | undefined;

/** The contained PDF host installs its shared pool once; merely importing this
 * module neither starts a worker nor makes the developer switch available. */
export function installPdfTiledSourceFactory(next: PdfTiledSourceFactory): () => void {
    if (factory && factory !== next) throw new Error('A PDF source factory is already installed');
    factory = next;
    return () => { if (factory === next) factory = undefined; };
}

export function getPdfTiledSourceFactory(): PdfTiledSourceFactory | undefined { return factory; }

/** The host is fetched only for an explicitly selected tiled document (C6.1). */
export async function ensurePdfTiledSourceFactory(): Promise<PdfTiledSourceFactory> {
    if (factory) return factory;
    const { startPdfPool } = await import('./startup');
    startPdfPool();
    if (!factory) throw new Error('The contained PDF engine is unavailable');
    return factory;
}
