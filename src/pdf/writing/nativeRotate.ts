import type { WorkerContext } from '../../platform/workers/serve';
import type { PageGeometry } from '../../platform/types';
import { Sha256 } from '../../utils/sha256';
import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import { WriterNativeDocument } from './nativeStage';
import { saveNativePdf } from './nativeSave';
import { rotationAttachmentInventory } from './rotationMetadata';
import { validateWriterSource } from './source';
import type { WriterOperations } from './protocol';

type Rotate = WriterOperations['writer.rotate'];
type Verify = WriterOperations['writer.verifyRotation'];
function turns(delta: number): number {
    if (!Number.isFinite(delta) || !Number.isSafeInteger(delta / 90)) throw new PdfEngineError('RangeError', 'Invalid PDF rotation');
    return ((delta / 90) % 4 + 4) % 4;
}
function selection(count: number, indices?: number[]): Set<number> {
    if (indices === undefined) return new Set(Array.from({ length: count }, (_, i) => i));
    if (!Array.isArray(indices) || indices.length > count || new Set(indices).size !== indices.length ||
        indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)) throw new PdfEngineError('RangeError', 'Invalid PDF rotation page');
    return new Set(indices);
}
function same(a: PageGeometry, b: PageGeometry): boolean {
    return a.index === b.index && a.width === b.width && a.height === b.height && a.rotate === b.rotate && a.userUnit === b.userUnit &&
        a.toUserSpace.length === 6 && b.toUserSpace.length === 6 && a.toUserSpace.every((n, i) => n === b.toUserSpace[i]);
}
async function geometries(runtime: PdfiumRuntime, doc: WriterNativeDocument, ctx: WorkerContext): Promise<PageGeometry[]> {
    const pages: PageGeometry[] = [];
    for (let i = 0, count = doc.pageCount(); i < count; i++) {
        await ctx.slice();
        const size = pdfiumPageSize(runtime, doc.handle, i, 14_400), page = runtime.call('FPDF_LoadPage', doc.handle, i) >>> 0;
        if (!page) throw new PdfEngineError('PageError', 'Cannot inspect PDF page for rotation');
        try { pages.push(pdfiumPageGeometry(runtime, page, i, size)); } finally { runtime.call('FPDF_ClosePage', page); }
    }
    return pages;
}
async function hash(bytes: Uint8Array, ctx: WorkerContext): Promise<string> {
    const digest = new Sha256();
    for (let i = 0; i < bytes.length; i += 1024 * 1024) { await ctx.slice(); digest.update(bytes.subarray(i, i + 1024 * 1024)); }
    return digest.digest();
}
async function sourceCheck(args: Pick<Rotate['args'], 'source'>, ctx: WorkerContext): Promise<string> {
    await validateWriterSource(args.source, () => ctx.slice());
    if (args.source.pristineFingerprint !== args.source.outerFingerprint) throw new PdfEngineError('NotSupported', 'Annotated PDFs cannot be rotated');
    return rotationAttachmentInventory(args.source.outer, ctx);
}

/** PDFium changes the original page graph, not a rebuilt or rasterized copy. */
export async function rotateNativePdf(runtime: PdfiumRuntime, args: Rotate['args'], context: WorkerContext): Promise<Rotate['result']> {
    const amount = turns(args.delta);
    await sourceCheck(args, context);
    const doc = await WriterNativeDocument.open(runtime, args.source.outer);
    try {
        doc.assertEditable();
        const count = doc.pageCount(), indices = selection(count, args.pageIndices);
        if (!count) throw new PdfEngineError('InvalidPdf', 'PDF has no pages');
        for (const index of indices) {
            await context.slice();
            const page = runtime.call('FPDF_LoadPage', doc.handle, index) >>> 0;
            if (!page) throw new PdfEngineError('PageError', 'Cannot open PDF page for rotation');
            try {
                const rotation = runtime.call('FPDFPage_GetRotation', page);
                if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) throw new PdfEngineError('PageError', 'Invalid PDF page rotation');
                const next = (rotation + amount) % 4;
                runtime.call('FPDFPage_SetRotation', page, next);
                if (runtime.call('FPDFPage_GetRotation', page) !== next) throw new PdfEngineError('PageError', 'PDF page rotation did not apply');
            } finally { runtime.call('FPDF_ClosePage', page); }
        }
        const expected = await geometries(runtime, doc, context);
        await context.slice();
        const output = saveNativePdf(doc, () => context.cancelled);
        return { bytes: output.buffer as ArrayBuffer, sourceFingerprint: args.source.outerFingerprint, geometries: expected };
    } finally { doc.close(); }
}

/** A fresh writer independently verifies the actual saved bytes before App may commit. */
export async function verifyNativeRotation(runtime: PdfiumRuntime, args: Verify['args'], context: WorkerContext): Promise<Verify['result']> {
    const amount = turns(args.delta), originalInventory = await sourceCheck(args, context);
    if (!(args.bytes instanceof ArrayBuffer) || args.bytes.byteLength < 8 || args.bytes.byteLength >= 0x80000000) throw new PdfEngineError('InvalidPdf', 'Invalid rotated output');
    const output = new Uint8Array(args.bytes), outputSha = await hash(output, context);
    if (await rotationAttachmentInventory(new Blob([output]), context) !== originalInventory) throw new PdfEngineError('NotSupported', 'PDF attachment or page resources changed during rotation');
    const original = await WriterNativeDocument.open(runtime, args.source.outer);
    let before: PageGeometry[];
    try { original.assertEditable(); before = await geometries(runtime, original, context); } finally { original.close(); }
    const check = WriterNativeDocument.openBytes(runtime, output);
    let after: PageGeometry[];
    try { check.assertEditable(); after = await geometries(runtime, check, context); } finally { check.close(); }
    const selected = selection(before.length, args.pageIndices);
    if (!before.length || after.length !== before.length || args.expected.length !== before.length) throw new PdfEngineError('InvalidPdf', 'Rotated page count changed');
    for (let i = 0; i < before.length; i++) {
        const rotation = (before[i].rotate + (selected.has(i) ? amount * 90 : 0)) % 360;
        if (after[i].rotate !== rotation || !same(after[i], args.expected[i]) || (!selected.has(i) && !same(after[i], before[i]))) {
            throw new PdfEngineError('InvalidPdf', 'Rotated page geometry changed unexpectedly');
        }
    }
    await context.slice();
    return { bytes: args.bytes, sourceFingerprint: args.source.outerFingerprint, outputSha, geometries: after };
}
