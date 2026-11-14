import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { NOTEBOOK_SOURCE_ATTACHMENT } from '../../utils/pdfFormat';
import type { DisplayPdfInput } from './types';
import { emitDocument } from './emit';
import type { WorkerContext } from '../../platform/workers/serve';

/** This accepts generated pages only; no imported PDF can enter the fresh-document route. */
export async function assembleDisplayPdf(input: DisplayPdfInput, context: WorkerContext): Promise<Uint8Array> {
    if (input.notebookSource) {
        const path = input.notebookSource.path;
        if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\\')) {
            throw new Error('Notebook source must be a vault-root-relative path');
        }
    }
    const generated = await emitDocument(input.pages, context);
    await context.slice();
    const doc = await PDFDocument.load(generated, { updateMetadata: false, parseSpeed: Infinity });
    if (doc.getPageCount() !== input.pages.length) throw new Error('Generated PDF page count changed');
    for (let i = 0; i < input.pages.length; i++) {
        const size = doc.getPage(i).getSize();
        if (size.width !== input.pages[i].width || size.height !== input.pages[i].height) throw new Error('Generated PDF page dimensions changed');
    }
    if (!input.notebookSource) return generated;
    const pointer = JSON.stringify({ path: input.notebookSource.path, exportedAt: Date.now() });
    const marker = 'local-vault-pdf/v1;role=notebook-source;format=notebook-source';
    await doc.attach(new TextEncoder().encode(pointer), NOTEBOOK_SOURCE_ATTACHMENT, {
        mimeType: 'application/json', description: `${marker}\nSource notebook`,
    });
    await context.slice();
    const bytes = await doc.save({ objectsPerTick: Infinity });
    await context.slice();
    const check = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity });
    if (check.getPageCount() !== input.pages.length) throw new Error('Notebook PDF verification failed');
    const names = check.catalog.lookup(PDFName.of('Names'), PDFDict);
    const tree = names?.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const pairs = tree?.lookup(PDFName.of('Names'), PDFArray);
    if (!pairs || pairs.size() !== 2) throw new Error('Notebook source pointer was not embedded');
    const name = pairs.lookup(0), spec = pairs.lookup(1, PDFDict);
    const description = spec.lookup(PDFName.of('Desc'));
    const ef = spec.lookup(PDFName.of('EF'), PDFDict);
    const stream = ef.lookup(PDFName.of('F'));
    if (!(name instanceof PDFString || name instanceof PDFHexString) || name.decodeText() !== NOTEBOOK_SOURCE_ATTACHMENT ||
        !(description instanceof PDFString || description instanceof PDFHexString) || !description.decodeText().startsWith(marker + '\n') ||
        !(stream instanceof PDFRawStream) || new TextDecoder('utf-8', { fatal: true }).decode(decodePDFRawStream(stream).getBytes(0)) !== pointer) {
        throw new Error('Notebook source pointer verification failed');
    }
    return bytes;
}
