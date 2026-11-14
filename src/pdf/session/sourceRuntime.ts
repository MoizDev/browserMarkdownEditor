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
