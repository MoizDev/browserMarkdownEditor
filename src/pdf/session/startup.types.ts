import type { PdfTiledSourceFactory } from './hostTypes';

export type EnsurePdfTiledSourceFactory = () => Promise<PdfTiledSourceFactory>;

export interface PdfFocusLease {
    setFocused(focused: boolean): void;
    dispose(): void;
}
