// Builds annotated PDFs off the main thread.
//
// Stamping overlays costs ~150ms per annotated page and scales linearly (~4.2s
// for 30 annotated pages, measured). On the main thread that lands as stutter
// under the pen, because the pen and the encoder share a thread. Here it costs
// the user nothing.

import { buildAnnotatedPdf, buildNotebookPdf } from './pdfBuild';
import type { NotebookPaper } from './paper';
import type { NotebookSource } from './pdfFormat';
import type { PageOverlay } from './pdfOverlay';

/** Stamping annotations back onto their source document. */
export interface AnnotateBuildRequest {
    kind: 'annotate';
    id: number;
    original: Uint8Array;
    snapshot: string;
    overlays: Array<PageOverlay | undefined>;
}

/** Writing a notebook out as ruled pages with the writing drawn on. */
export interface NotebookBuildRequest {
    kind: 'notebook';
    id: number;
    paper: NotebookPaper;
    overlays: Array<PageOverlay | undefined>;
    /** The notebook this came from, stamped in so annotating the PDF can find
     *  its way back. */
    source?: NotebookSource;
}

export type PdfBuildRequest = AnnotateBuildRequest | NotebookBuildRequest;

export type PdfBuildResponse =
    | { id: number; bytes: Uint8Array; error?: undefined }
    | { id: number; bytes?: undefined; error: string };

self.onmessage = async (e: MessageEvent<PdfBuildRequest>) => {
    const { id } = e.data;
    try {
        const bytes = e.data.kind === 'notebook'
            ? await buildNotebookPdf(e.data.paper, e.data.overlays, e.data.source)
            : await buildAnnotatedPdf(e.data.original, e.data.snapshot, e.data.overlays);
        // Transfer rather than copy: the worker has no further use for these
        // bytes, and they can be megabytes.
        (self as unknown as Worker).postMessage({ id, bytes } satisfies PdfBuildResponse, [bytes.buffer as ArrayBuffer]);
    } catch (err) {
        (self as unknown as Worker).postMessage({
            id,
            error: err instanceof Error ? err.message : String(err),
        } satisfies PdfBuildResponse);
    }
};
