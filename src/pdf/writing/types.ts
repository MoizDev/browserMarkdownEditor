import type { PageDisplayList } from '../../platform/types';

export interface DisplayPdfPage {
    width: number;
    height: number;
    displayList: PageDisplayList;
    paper?: PageDisplayList;
}

export interface DisplayPdfInput {
    schema: 1;
    pages: readonly DisplayPdfPage[];
    notebookSource?: { path: string };
}

export interface InkPageInput {
    sourcePage: number;
    width: number;
    height: number;
    displayList: PageDisplayList;
}
export interface InkPackage {
    schema: 1;
    bytes: Uint8Array;
    pages: Array<{ sourcePage: number; inkPage: number; width: number; height: number; hash: string }>;
}
