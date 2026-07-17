// Builds annotated PDFs off the main thread.
//
// Stamping overlays costs ~150ms per annotated page and scales linearly (~4.2s
// for 30 annotated pages, measured). On the main thread that lands as stutter
// under the pen, because the pen and the encoder share a thread. Here it costs
// the user nothing.

import { buildAnnotatedPdf } from './pdfBuild';

export interface PdfBuildRequest {
    id: number;
    original: Uint8Array;
    snapshot: string;
    overlays: Array<Uint8Array | undefined>;
}

export type PdfBuildResponse =
    | { id: number; bytes: Uint8Array; error?: undefined }
    | { id: number; bytes?: undefined; error: string };

self.onmessage = async (e: MessageEvent<PdfBuildRequest>) => {
    const { id, original, snapshot, overlays } = e.data;
    try {
        const bytes = await buildAnnotatedPdf(original, snapshot, overlays);
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
