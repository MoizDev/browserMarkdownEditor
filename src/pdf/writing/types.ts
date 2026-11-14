import type { PageDisplayList } from '../../platform/types';

/** Generated documents only. Imported PDFs have a separate, preservation-aware assembler. */
export interface DisplayPdfPage {
    width: number;
    height: number;
    displayList: PageDisplayList;
    /** Ruling from the same model as the screen; equal paper lists share one Form. */
    paper?: PageDisplayList;
}

export interface DisplayPdfInput {
    pages: readonly DisplayPdfPage[];
    notebookSource?: { path: string };
}

/** Standalone ink pages for a later preservation-aware imported-PDF assembler. */
export interface InkPageInput {
    sourcePage: number;
    width: number;
    height: number;
    displayList: PageDisplayList;
}
export interface InkPackage {
    schema: 1;
    bytes: Uint8Array;
    pages: Array<{ sourcePage: number; inkPage: number; width: number; height: number }>;
}
