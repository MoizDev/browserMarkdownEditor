import type { PdfTiledSourceFactory } from './hostTypes';

/** The lazy contained host owns one pool; a failed startup never selects the classic reader. */
export type EnsurePdfTiledSourceFactory = () => Promise<PdfTiledSourceFactory>;

/** Visibility/focus changes update scheduling without recreating the shared pool. */
export interface PdfFocusLease {
    setFocused(focused: boolean): void;
    dispose(): void;
}
