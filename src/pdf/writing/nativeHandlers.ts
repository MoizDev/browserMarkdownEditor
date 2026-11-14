import { loadPdfiumModule } from '../engine/pdfium/loader';
import { withPdfiumMemory, heapView } from '../engine/pdfium/memory';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import { PdfEngineError } from '../engine/types';
import { emitDocument } from './emit';
import { PdfiumWriter } from './pdfiumWriter';
import { WriterNativeDocument } from './nativeStage';
import { inventoryNativeAttachments } from './nativeInventory';
import { buildNativeNotebook } from './nativeNotebook';
import { rotateNativePdf } from './nativeRotate';
import { validateWriterSource } from './source';
import type { CreatePdfWriterRuntime, PdfWriterHandler } from './nativeHandlers.types';
import type { WriterOperations } from './protocol';

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PdfEngineError('InvalidPdf', 'Invalid writer arguments');
    return value as Record<string, unknown>;
}
function revision(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function id(value: unknown): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 256; }

export const createPdfWriterRuntime: CreatePdfWriterRuntime = async options => {
    if (options.role !== 'writer') throw new PdfEngineError('EngineBroken', 'Writer role required');
    const runtime = await loadPdfiumModule(Object.freeze({ ...options, role: 'writer' }));
    try {
        withPdfiumMemory(runtime, runtime.abi.structs.libraryConfig.size, pointer => {
            heapView(runtime, pointer, runtime.abi.structs.libraryConfig.size).setInt32(runtime.abi.structs.libraryConfig.offsets.version, 2, true);
            runtime.initLibrary(pointer);
        });
    } catch (error) { runtime.dispose(); throw error; }
    const writer = new PdfiumWriter(runtime);
    let closed = false, queue: Promise<unknown> = Promise.resolve();
    const serial = (fn: PdfWriterHandler): PdfWriterHandler => (args, context) => {
        const run = queue.then(async () => {
            if (closed || context.cancelled) throw new PdfEngineError('AbortError', 'Writer closed or cancelled');
            const result = await fn(args, context);
            if (closed || context.cancelled) throw new PdfEngineError('AbortError', 'Writer closed or cancelled');
            return result;
        });
        queue = run.catch(() => {});
        return run;
    };
    const handlers: Record<keyof WriterOperations, PdfWriterHandler> = {
        'writer.prepareSource': serial((value, ctx) => {
            const args = object(value); object(args.source);
            return writer.prepareSource(args as unknown as WriterOperations['writer.prepareSource']['args'], ctx);
        }),
        'writer.emitInk': serial(async (value, ctx) => {
            const args = object(value);
            if (!revision(args.revision) || args.displayListSchema !== 1 || !Array.isArray(args.pages)) throw new PdfEngineError('InvalidPdf', 'Invalid ink request');
            const pages = args.pages as WriterOperations['writer.emitInk']['args']['pages'];
            const seen = new Set<number>();
            for (const page of pages) {
                if (!page || !Number.isSafeInteger(page.sourcePage) || page.sourcePage < 0 || seen.has(page.sourcePage) || page.displayList?.page !== page.sourcePage) throw new PdfEngineError('InvalidPdf', 'Invalid ink page map');
                seen.add(page.sourcePage);
            }
            const emitted = await emitDocument(pages.map((page, index) => ({ ...page, displayList: { ...page.displayList, page: index } })), ctx);
            await ctx.slice();
            return { schema: 1, pdf: new Blob([new Uint8Array(emitted.bytes)]), pages: pages.map((page, inkPage) => ({ sourcePage: page.sourcePage, inkPage, width: page.width, height: page.height, hash: emitted.hashes[inkPage] })) };
        }),
        'writer.stageAnnotated': serial((value, ctx) => {
            const args = object(value);
            if (!id(args.writerSession) || !revision(args.revision) || !Array.isArray(args.geometries) || !Array.isArray(args.reservedNames)) throw new PdfEngineError('InvalidPdf', 'Invalid stage request');
            const ink = object(args.ink);
            if (ink.schema !== 1 || !(ink.pdf instanceof Blob) || !Array.isArray(ink.pages)) throw new PdfEngineError('InvalidPdf', 'Invalid ink package');
            return writer.stageAnnotated(args as unknown as WriterOperations['writer.stageAnnotated']['args'], ctx);
        }),
        'writer.finishAnnotated': serial(async (value, ctx) => {
            const args = object(value);
            if (!id(args.stageId) || !revision(args.revision) || !Array.isArray(args.attachments) || typeof args.writeId !== 'string') throw new PdfEngineError('InvalidPdf', 'Invalid finish request');
            const result = await writer.finishAnnotated(args as unknown as WriterOperations['writer.finishAnnotated']['args'], ctx);
            ctx.transfer(result.bytes); return result;
        }),
        'writer.buildNotebook': serial(async (value, ctx) => {
            const args = object(value);
            if (!Array.isArray(args.pages) || !revision(args.revision) || args.displayListSchema !== 1 || typeof args.writeId !== 'string') throw new PdfEngineError('InvalidPdf', 'Invalid notebook request');
            const result = await buildNativeNotebook(runtime, args as unknown as WriterOperations['writer.buildNotebook']['args'], ctx);
            ctx.transfer(result.bytes); return result;
        }),
        'writer.rotate': serial(async (value, ctx) => {
            const args = object(value); object(args.source);
            if ((args.delta !== 90 && args.delta !== -90) || (args.pageIndices !== undefined && !Array.isArray(args.pageIndices))) throw new PdfEngineError('InvalidPdf', 'Invalid rotation request');
            const result = await rotateNativePdf(runtime, args as unknown as WriterOperations['writer.rotate']['args'], ctx);
            ctx.transfer(result.bytes); return result;
        }),
        'writer.inspect': serial(async (value, ctx) => {
            const args = object(value); object(args.source);
            if (typeof args.includeAttachments !== 'boolean' || (args.signaturePolicy !== 'inspect' && args.signaturePolicy !== 'refuse')) throw new PdfEngineError('InvalidPdf', 'Invalid inspection request');
            const source = (args as unknown as WriterOperations['writer.inspect']['args']).source;
            await validateWriterSource(source, () => ctx.slice());
            const doc = await WriterNativeDocument.open(runtime, source.outer);
            try {
                const encrypted = runtime.call('FPDF_GetSecurityHandlerRevision', doc.handle) !== -1;
                const signatures = runtime.call('FPDF_GetSignatureCount', doc.handle);
                if (!Number.isSafeInteger(signatures) || signatures < 0) throw new PdfEngineError('InvalidPdf', 'Cannot inspect PDF signatures');
                const signed = signatures > 0;
                if (signed && args.signaturePolicy === 'refuse') throw new PdfEngineError('NotSupported', 'Signed PDF cannot be safely rebuilt');
                const pageCount = doc.pageCount(), geometries = [];
                for (let i = 0; i < pageCount; i++) {
                    await ctx.slice();
                    const size = pdfiumPageSize(runtime, doc.handle, i, 14_400), page = runtime.call('FPDF_LoadPage', doc.handle, i) >>> 0;
                    if (!page) throw new PdfEngineError('PageError', 'Cannot inspect PDF page');
                    try { geometries.push(pdfiumPageGeometry(runtime, page, i, size)); } finally { runtime.call('FPDF_ClosePage', page); }
                }
                const attachments = args.includeAttachments ? (await inventoryNativeAttachments(doc, () => ctx.slice())).map(({ name, sha256 }) => ({ name, sha256 })) : [];
                return { pageCount, geometries, encrypted, signed, attachments };
            } finally { doc.close(); }
        }),
        'writer.release': serial(async value => {
            const args = object(value);
            if (!id(args.writerSession)) throw new PdfEngineError('InvalidPdf', 'Invalid writer session');
            await writer.release(args.writerSession as string); return {};
        }),
    };
    return {
        info: { engine: 'pdfium', version: '6688c576fd851f4159c6fae39396da50939de110', artifactSha256: runtime.artifactSha256, buildId: runtime.buildId, features: ['attachments', 'write'] },
        handlers,
        heapBytes: () => closed ? 0 : runtime.HEAPU8.byteLength,
        async close() { if (closed) return; closed = true; await queue; try { await writer.dispose(); } finally { runtime.dispose(); } },
    };
};
