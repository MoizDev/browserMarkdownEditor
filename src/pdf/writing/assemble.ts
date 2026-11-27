import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { inventoryAttachments } from '../../utils/pdfAttachmentTree';
import { NOTEBOOK_SOURCE_ATTACHMENT } from '../../utils/pdfFormat';
import { inspectPdfDocumentWriteSafety } from '../../utils/pdfWriteSafety';
import type { WorkerContext } from '../../platform/workers/serve';
import { validNotebookSourcePath } from './notebookPointer';
import { readPdfNotebookPointer } from './notebookInspection';

export interface GeneratedNotebookRequest {
    readonly kind: 'pre-emitted';
    readonly revision: number;
    readonly pdf: Blob;
    readonly pages: readonly { readonly width: number; readonly height: number }[];
    readonly notebookSource: { readonly path: string };
}
type PageSize = { readonly width: number; readonly height: number };

function verifyGeometry(doc: PDFDocument, pages: readonly PageSize[]): void {
    if (doc.getPageCount() !== pages.length) throw new Error('Generated PDF page count changed');
    for (let i = 0; i < pages.length; i++) {
        const page = doc.getPage(i), expected = pages[i], media = page.getMediaBox(), crop = page.getCropBox();
        const unit = doc.context.lookup(page.node.getInheritableAttribute(PDFName.of('UserUnit')));
        if (page.getRotation().angle !== 0 || (unit !== undefined && (!(unit instanceof PDFNumber) || unit.asNumber() !== 1)) ||
            media.x !== 0 || media.y !== 0 || media.width !== expected.width || media.height !== expected.height ||
            crop.x !== 0 || crop.y !== 0 || crop.width !== expected.width || crop.height !== expected.height) {
            throw new Error('Generated PDF page geometry changed');
        }
    }
}
function checkRequest(input: GeneratedNotebookRequest): void {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.kind !== 'pre-emitted' ||
        Object.keys(input).some(key => !['kind', 'revision', 'pdf', 'pages', 'notebookSource'].includes(key)) ||
        !Number.isSafeInteger(input.revision) || input.revision < 0 || !(input.pdf instanceof Blob) ||
        typeof File !== 'undefined' && input.pdf instanceof File || input.pdf.size < 8 || input.pdf.size >= 0x80000000 ||
        !input.notebookSource || typeof input.notebookSource !== 'object' || Array.isArray(input.notebookSource) ||
        Object.keys(input.notebookSource).some(key => key !== 'path') || !validNotebookSourcePath(input.notebookSource.path) ||
        input.notebookSource.path.length > 4096 || !Array.isArray(input.pages) || !input.pages.length || input.pages.length > 100_000) {
        throw new Error('Invalid generated notebook request');
    }
    for (const page of input.pages) {
        if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).some(key => key !== 'width' && key !== 'height') ||
            !Number.isFinite(page.width) || page.width <= 0 || page.width > 14_400 ||
            !Number.isFinite(page.height) || page.height <= 0 || page.height > 14_400) throw new Error('Invalid generated notebook page');
    }
}

async function finishNotebook(generated: Uint8Array, pages: readonly PageSize[], path: string, context: WorkerContext): Promise<Uint8Array> {
    await context.slice();
    const doc = await PDFDocument.load(generated, { updateMetadata: false, parseSpeed: Infinity, throwOnInvalidObject: true });
    if (inspectPdfDocumentWriteSafety(doc).kind !== 'safe' || inventoryAttachments(doc).length !== 0) throw new Error('Generated notebook source is not safe and attachment-free');
    verifyGeometry(doc, pages);
    const pointer = JSON.stringify({ path, exportedAt: Date.now() });
    const marker = 'local-vault-pdf/v1;role=notebook-source;format=notebook-source';
    await doc.attach(new TextEncoder().encode(pointer), NOTEBOOK_SOURCE_ATTACHMENT, {
        mimeType: 'application/json', description: `${marker}\nSource notebook`,
    });
    await context.slice();
    const bytes = await doc.save({ objectsPerTick: Infinity });
    await context.slice();
    const check = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity, throwOnInvalidObject: true });
    if (inspectPdfDocumentWriteSafety(check).kind !== 'safe' || inventoryAttachments(check).length !== 1) throw new Error('Notebook PDF attachment verification failed');
    verifyGeometry(check, pages);
    const actual = readPdfNotebookPointer(check);
    if (actual.path !== path || actual.exportedAt === undefined || JSON.stringify(actual) !== pointer) throw new Error('Notebook source pointer verification failed');
    await context.slice();
    return bytes;
}

export async function finishGeneratedNotebook(input: GeneratedNotebookRequest, context: WorkerContext): Promise<Uint8Array> {
    checkRequest(input);
    await context.slice();
    const generated = new Uint8Array(await input.pdf.arrayBuffer());
    await context.slice();
    return finishNotebook(generated, input.pages, input.notebookSource.path, context);
}
