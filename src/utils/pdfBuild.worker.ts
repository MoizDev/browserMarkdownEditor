import { buildAnnotatedPdf, buildNotebookPdf } from './pdfBuild';
import { inspectPdfRole } from './pdfAttachmentInventory';
import type { PdfRole } from './pdfRole';
import type { NotebookPaper } from './paper';
import type { NotebookSource } from './pdfFormat';
import type { PageOverlay } from './pdfOverlay';
import { PdfBuildRefused } from './pdfBuildRefusal';
import type { PdfBuildRefusal } from './pdfBuildRefusal';

export interface AnnotateBuildRequest {
    kind: 'annotate';
    id: number;
    original: Uint8Array;
    outer?: Uint8Array;
    snapshot: string;
    overlays: Array<PageOverlay | undefined>;
}

export interface NotebookBuildRequest {
    kind: 'notebook';
    id: number;
    paper: NotebookPaper;
    overlays: Array<PageOverlay | undefined>;
    source?: NotebookSource;
}

export interface InspectRoleRequest {
    kind: 'inspect-role';
    id: number;
    bytes: Uint8Array;
    generation: string;
}
export type PdfBuildRequest = AnnotateBuildRequest | NotebookBuildRequest | InspectRoleRequest;

export type PdfBuildResponse =
    | { id: number; bytes: Uint8Array; aliases?: string[]; role?: undefined; error?: undefined; refusal?: undefined }
    | { id: number; role: PdfRole; bytes?: undefined; aliases?: undefined; error?: undefined; refusal?: undefined }
    | { id: number; refusal: PdfBuildRefusal; bytes?: undefined; aliases?: undefined; role?: undefined; error?: undefined }
    | { id: number; bytes?: undefined; aliases?: undefined; role?: undefined; error: string; refusal?: undefined };

self.onmessage = async (e: MessageEvent<PdfBuildRequest>) => {
    const request = e.data;
    const { id } = request;
    try {
        if (request.kind === 'inspect-role') {
            const role = await inspectPdfRole(request.bytes, request.generation);
            const transfer = role.kind === 'plain' || role.kind === 'annotated' ? [role.original.buffer as ArrayBuffer] : [];
            (self as unknown as Worker).postMessage({ id, role } satisfies PdfBuildResponse, transfer);
            return;
        }
        const result = request.kind === 'annotate'
            ? await buildAnnotatedPdf(request.original, request.snapshot, request.overlays, request.outer)
            : { bytes: await buildNotebookPdf(request.paper, request.overlays, request.source), aliases: [] };
        const { bytes, aliases } = result;
        (self as unknown as Worker).postMessage({ id, bytes, aliases } satisfies PdfBuildResponse, [bytes.buffer as ArrayBuffer]);
    } catch (err) {
        if (err instanceof PdfBuildRefused) {
            (self as unknown as Worker).postMessage({ id, refusal: err.refusal } satisfies PdfBuildResponse);
            return;
        }
        (self as unknown as Worker).postMessage({
            id,
            error: err instanceof Error ? err.message : String(err),
        } satisfies PdfBuildResponse);
    }
};
