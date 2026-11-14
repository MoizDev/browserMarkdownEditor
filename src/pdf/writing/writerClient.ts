import type { PdfRequestOptions, PdfWriterSession } from '../pool/types';
import type { WriterOperations } from './protocol';

type WriterOp = keyof WriterOperations;
type Args<K extends WriterOp> = WriterOperations[K]['args'];
type Result<K extends WriterOp> = WriterOperations[K]['result'];
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finiteCount(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }

/** A contained writer cannot authorize a filesystem commit: this validates the
 * reply's shape, then the App save funnel rechecks owner, revision and disk. */
function validateReply(op: WriterOp, value: unknown): void {
    if (!record(value)) throw new Error('Malformed PDF writer response');
    if (op === 'writer.prepareSource') {
        if (typeof value.writerSession !== 'string' || !value.writerSession || typeof value.sourceFingerprint !== 'string' || !HASH.test(value.sourceFingerprint) || !record(value.inspection)) throw new Error('Malformed PDF writer preparation');
    } else if (op === 'writer.emitInk') {
        if (value.schema !== 1 || !(value.pdf instanceof Blob) || !value.pdf.size || !Array.isArray(value.pages) ||
            value.pages.some(page => !record(page) || !finiteCount(page.sourcePage) || !finiteCount(page.inkPage) ||
                typeof page.width !== 'number' || !Number.isFinite(page.width) || page.width <= 0 ||
                typeof page.height !== 'number' || !Number.isFinite(page.height) || page.height <= 0 ||
                typeof page.hash !== 'string' || !HASH.test(page.hash))) throw new Error('Malformed emitted ink');
    } else if (op === 'writer.stageAnnotated') {
        if (typeof value.stageId !== 'string' || !value.stageId || typeof value.sourceFingerprint !== 'string' || !HASH.test(value.sourceFingerprint) || !record(value.geometryEngine)) throw new Error('Malformed staged PDF');
    } else if (op === 'writer.finishAnnotated') {
        if (!(value.bytes instanceof ArrayBuffer) || !value.bytes.byteLength || !finiteCount(value.revision) ||
            typeof value.writeId !== 'string' || !ID.test(value.writeId) || typeof value.sourceFingerprint !== 'string' || !HASH.test(value.sourceFingerprint) ||
            !record(value.verification) || value.verification.writeMark !== 'verified' || !finiteCount(value.verification.pageCount) || !finiteCount(value.verification.attachmentCount)) throw new Error('Malformed completed PDF');
    } else if (op === 'writer.buildNotebook' || op === 'writer.rotate') {
        if (!(value.bytes instanceof ArrayBuffer) || !value.bytes.byteLength) throw new Error('Malformed generated PDF');
    } else if (op === 'writer.inspect') {
        if (!finiteCount(value.pageCount) || !Array.isArray(value.geometries) || !Array.isArray(value.attachments) || typeof value.encrypted !== 'boolean' || typeof value.signed !== 'boolean') throw new Error('Malformed PDF inspection');
    }
}

export interface TypedPdfWriter {
    request<K extends WriterOp>(op: K, args: Args<K>, options: PdfRequestOptions): Promise<Result<K>>;
    close(): Promise<void>;
}

export function typedPdfWriter(session: PdfWriterSession): TypedPdfWriter {
    return {
        async request<K extends WriterOp>(op: K, args: Args<K>, options: PdfRequestOptions): Promise<Result<K>> {
            const result = await session.request(op, args, options);
            validateReply(op, result);
            if (op === 'writer.prepareSource') {
                const input = args as WriterOperations['writer.prepareSource']['args'];
                const output = result as WriterOperations['writer.prepareSource']['result'];
                if (output.sourceFingerprint !== input.source.pristineFingerprint) throw new Error('PDF writer prepared a different source');
            }
            if (op === 'writer.finishAnnotated') {
                const input = args as WriterOperations['writer.finishAnnotated']['args'];
                const output = result as WriterOperations['writer.finishAnnotated']['result'];
                if (output.revision !== input.revision || output.writeId !== input.writeId) throw new Error('PDF writer returned a different revision');
            }
            return result;
        },
        close: () => session.close(),
    };
}
