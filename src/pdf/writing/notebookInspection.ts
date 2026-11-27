import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { boundedAttachmentBytes, inventoryAttachments } from '../../utils/pdfAttachmentTree';
import { NOTEBOOK_SOURCE_ATTACHMENT } from '../../utils/pdfFormat';
import { attachmentMarker } from './attachments';
import { validNotebookSourcePath } from './notebookPointer';
import { parseJson } from '../../whiteboard/format/jsonRead';

function assertUniqueTreeNames(doc: PDFDocument): void {
    const names = doc.catalog.lookup(PDFName.of('Names'));
    if (names === undefined) return;
    if (!(names instanceof PDFDict)) throw new Error('Invalid notebook PDF name tree');
    const root = names.get(PDFName.of('EmbeddedFiles'));
    if (!root) return;
    const stack = [{ node: root, depth: 0 }], seen = new Set<PDFDict>(), keys = new Set<string>();
    while (stack.length) {
        const { node, depth } = stack.pop()!, object = doc.context.lookup(node);
        if (!(object instanceof PDFDict) || seen.has(object) || depth > 64 || seen.size >= 100_000) throw new Error('Invalid notebook PDF name tree');
        seen.add(object);
        const pairs = object.lookup(PDFName.of('Names'));
        if (pairs !== undefined) {
            if (!(pairs instanceof PDFArray) || pairs.size() % 2 || pairs.size() > 200_000) throw new Error('Invalid notebook PDF names');
            for (let i = 0; i < pairs.size(); i += 2) {
                const name = pairs.lookup(i);
                if (!(name instanceof PDFString || name instanceof PDFHexString)) throw new Error('Invalid notebook PDF name');
                const value = name.decodeText();
                if (keys.has(value) || keys.size >= 100_000) throw new Error('Duplicate notebook PDF name');
                keys.add(value);
            }
        }
        const kids = object.lookup(PDFName.of('Kids'));
        if (kids !== undefined) {
            if (!(kids instanceof PDFArray) || kids.size() > 100_000 - seen.size - stack.length) throw new Error('Invalid notebook PDF name tree');
            for (let i = 0; i < kids.size(); i++) stack.push({ node: kids.get(i), depth: depth + 1 });
        }
    }
}

function assertUniqueAssociations(doc: PDFDocument): void {
    const seen = new Set<PDFDict>();
    let visited = 0;
    const add = (raw: ReturnType<PDFDict['get']>) => {
        const value = doc.context.lookup(raw);
        if (!(value instanceof PDFDict) || seen.has(value)) throw new Error('Duplicate or invalid notebook PDF association');
        seen.add(value);
    };
    const associations = (dictionary: PDFDict) => {
        const af = dictionary.lookup(PDFName.of('AF'));
        if (af === undefined) return;
        if (!(af instanceof PDFArray) || af.size() > 100_000) throw new Error('Invalid notebook PDF associations');
        for (let i = 0; i < af.size(); i++) add(af.get(i));
    };
    associations(doc.catalog);
    for (const page of doc.getPages()) {
        associations(page.node);
        const annotations = page.node.lookup(PDFName.of('Annots'));
        if (annotations === undefined) continue;
        if (!(annotations instanceof PDFArray) || annotations.size() > 100_000) throw new Error('Invalid notebook PDF annotations');
        for (let i = 0; i < annotations.size(); i++) {
            if (++visited > 100_000) throw new Error('Notebook PDF annotation limit exceeded');
            const annotation = annotations.lookup(i);
            if (!(annotation instanceof PDFDict)) throw new Error('Invalid notebook PDF annotation');
            associations(annotation);
            if (annotation.lookup(PDFName.of('Subtype')) === PDFName.of('FileAttachment')) add(annotation.get(PDFName.of('FS')));
        }
    }
}

export interface PdfNotebookPointer { path: string; exportedAt?: number }

export function readPdfNotebookPointer(doc: PDFDocument): PdfNotebookPointer {
    assertUniqueTreeNames(doc);
    assertUniqueAssociations(doc);
    const matches = inventoryAttachments(doc).filter(entry => entry.names.has(NOTEBOOK_SOURCE_ATTACHMENT));
    if (matches.length !== 1) throw new Error('Notebook PDF source pointer is not unique');
    const entry = matches[0];
    if (entry.keys.length > 1 || entry.names.size !== 1 || !entry.names.has(NOTEBOOK_SOURCE_ATTACHMENT) ||
        entry.description.split('\n', 1)[0] !== attachmentMarker('notebook-source', 'notebook-source')) {
        throw new Error('Invalid notebook PDF source marker');
    }
    const ef = entry.spec.lookup(PDFName.of('EF'));
    if (!(ef instanceof PDFDict)) throw new Error('Notebook PDF source is unreadable');
    const f = ef.lookup(PDFName.of('F')), uf = ef.lookup(PDFName.of('UF'));
    if (f && uf && f !== uf) throw new Error('Notebook PDF source has conflicting streams');
    const stream = uf ?? f;
    if (!(stream instanceof PDFRawStream)) throw new Error('Notebook PDF source is unreadable');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(boundedAttachmentBytes(stream, 4096));
    const fields = parseJson(json).fieldMap();
    if (!fields.has('path') || [...fields.keys()].some(key => key !== 'path' && key !== 'exportedAt')) throw new Error('Invalid notebook PDF source pointer');
    const path = fields.get('path')!.string(4096);
    const exportedAt = fields.has('exportedAt') ? fields.get('exportedAt')!.number() : undefined;
    if (!validNotebookSourcePath(path) || (exportedAt !== undefined && (!Number.isFinite(exportedAt) || exportedAt < 0))) {
        throw new Error('Invalid notebook PDF source pointer');
    }
    return { path, ...(exportedAt !== undefined ? { exportedAt } : {}) };
}

export async function inspectPdfNotebook(outer: Blob, expectedPath: string, cooperate: () => Promise<void>): Promise<{ path: string; pageCount: number }> {
    if (!(outer instanceof Blob) || typeof File !== 'undefined' && outer instanceof File || outer.size < 1 || outer.size > 0x7fffffff ||
        !validNotebookSourcePath(expectedPath)) throw new Error('Invalid notebook PDF inspection source');
    await cooperate();
    const bytes = new Uint8Array(await outer.arrayBuffer());
    await cooperate();
    const doc = await PDFDocument.load(bytes, { parseSpeed: Infinity, updateMetadata: false });
    await cooperate();
    const pageCount = doc.getPageCount();
    if (doc.isEncrypted || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100_000 || inventoryAttachments(doc).length !== 1) throw new Error('Invalid notebook PDF');
    const pointer = readPdfNotebookPointer(doc);
    if (pointer.path !== expectedPath || pointer.exportedAt === undefined) throw new Error('Notebook PDF source pointer does not match');
    await cooperate();
    return { path: pointer.path, pageCount };
}
