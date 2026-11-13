// Builds annotated PDFs off the main thread.
//
// Stamping overlays costs ~150ms per annotated page and scales linearly (~4.2s
// for 30 annotated pages, measured). On the main thread that lands as stutter
// under the pen, because the pen and the encoder share a thread. Here it costs
// the user nothing.
//
// Rotation runs here too, for a different reason: not the work (~0.3s of
// pdf-lib for a 1,105-page book) but pdf-lib's idle ticks, which the browser
// stretches to a second apiece while the window is hidden — see pdfBuild.ts.

import { buildAnnotatedPdf, buildNotebookPdf } from './pdfBuild';
import { rotatePdfPages } from './pdfRotate';
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

/** Turning pages a quarter (`/Rotate`), the whole document or one page.
 *  `bytes` arrives TRANSFERRED, so it is this worker's alone. */
export interface RotateRequest {
    kind: 'rotate';
    id: number;
    bytes: Uint8Array;
    delta: number;
    pageIndex?: number;
}

export type PdfBuildRequest = AnnotateBuildRequest | NotebookBuildRequest | RotateRequest;

export type PdfBuildResponse =
    | { id: number; bytes: Uint8Array; error?: undefined }
    | { id: number; bytes?: undefined; error: string };

self.onmessage = async (e: MessageEvent<PdfBuildRequest>) => {
    const request = e.data;
    const { id } = request;
    try {
        const bytes = request.kind === 'notebook'
            ? await buildNotebookPdf(request.paper, request.overlays, request.source)
            : request.kind === 'rotate'
                ? await rotatePdfPages(request.bytes, request.delta, request.pageIndex)
                : await buildAnnotatedPdf(request.original, request.snapshot, request.overlays);
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
