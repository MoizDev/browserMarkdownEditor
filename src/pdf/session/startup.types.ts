import type { PdfTiledSourceFactory } from './hostTypes';

/** The lazy contained host owns one pool; a failed startup never selects the classic reader. */
export type EnsurePdfTiledSourceFactory = () => Promise<PdfTiledSourceFactory>;
