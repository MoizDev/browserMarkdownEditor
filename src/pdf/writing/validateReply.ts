import { createPdfReplyValidators } from '../pool/validation';
import { boolean, finite, integer, invalidPdfReply, record, text } from '../pool/validationCommon';
import type { AttachmentDescriptor, AttachmentMetadata, WriterInspection, WriterOperations } from './protocol';

const MAX_FILE = 0x7fffffff, MAX_PAGES = 100_000, MAX_ATTACHMENTS = 10_000;
const HASH = /^[0-9a-f]{64}$/, WRITE_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const geometry = createPdfReplyValidators().geometry;

function list(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) invalidPdfReply();
    return value;
}
function matching(value: unknown, pattern: RegExp): string {
    const result = text(value, 128);
    if (!pattern.test(result)) invalidPdfReply();
    return result;
}
function outputBytes(value: unknown): ArrayBuffer {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 1 || value.byteLength > MAX_FILE) invalidPdfReply();
    return value.slice(0);
}
function fingerprint(value: unknown): string { return matching(value, HASH); }
function exact(actual: unknown, expected: unknown): void { if (actual !== expected) invalidPdfReply(); }
function id(value: unknown): string { return matching(value, UUID); }
function metadata(value: unknown): AttachmentMetadata {
    const o = record(value, ['description', 'mimeType', 'relationship', 'created', 'modified']);
    const out: AttachmentMetadata = {};
    if (o.description !== undefined) out.description = text(o.description, 1024);
    if (o.mimeType !== undefined) out.mimeType = text(o.mimeType, 1024);
    if (o.created !== undefined) out.created = text(o.created, 1024);
    if (o.modified !== undefined) out.modified = text(o.modified, 1024);
    if (o.relationship !== undefined) {
        if (o.relationship !== 'Source' && o.relationship !== 'Data' && o.relationship !== 'Alternative' &&
            o.relationship !== 'Supplement' && o.relationship !== 'Unspecified') invalidPdfReply();
        out.relationship = o.relationship;
    }
    return out;
}
function descriptor(value: unknown): AttachmentDescriptor {
    const o = record(value, ['name', 'sha256', 'metadata']);
    const name = text(o.name, 1024);
    if (!name || name.includes('\0')) invalidPdfReply();
    return { name, sha256: fingerprint(o.sha256), ...(o.metadata !== undefined ? { metadata: metadata(o.metadata) } : {}) };
}
function geometries(value: unknown) {
    return list(value, MAX_PAGES).map((page, index) => geometry(page, index));
}
function inspection(value: unknown): WriterInspection {
    const o = record(value, ['pageCount', 'geometries', 'encrypted', 'signed', 'attachments']);
    const pageCount = integer(o.pageCount, 0, MAX_PAGES), pages = geometries(o.geometries);
    if (pages.length !== pageCount) invalidPdfReply();
    return { pageCount, geometries: pages, encrypted: boolean(o.encrypted), signed: boolean(o.signed),
        attachments: list(o.attachments, MAX_ATTACHMENTS).map(descriptor) };
}
function revision(value: unknown, expected: number): number {
    const n = integer(value, 0, Number.MAX_SAFE_INTEGER); exact(n, expected); return n;
}
function writeId(value: unknown, expected: string): string {
    const result = matching(value, WRITE_ID); exact(result, expected); return result;
}

/** Rebuild every response at the privileged boundary; session-bound comparisons
 * require the caller's retained prepare/stage state, not worker-provided claims. */
export function validatePdfWriterReply<K extends keyof WriterOperations>(op: K, value: unknown,
    args: WriterOperations[K]['args']): WriterOperations[K]['result'] {
    let result: WriterOperations[keyof WriterOperations]['result'];
    switch (op) {
        case 'writer.prepareSource': {
            const input = args as WriterOperations['writer.prepareSource']['args'];
            const o = record(value, ['writerSession', 'sourceFingerprint', 'inspection']);
            const sourceFingerprint = fingerprint(o.sourceFingerprint); exact(sourceFingerprint, input.source.pristineFingerprint);
            result = { writerSession: id(o.writerSession), sourceFingerprint, inspection: inspection(o.inspection) };
            break;
        }
        case 'writer.inspect': result = inspection(value); break;
        case 'writer.emitInk': {
            const input = args as WriterOperations['writer.emitInk']['args'];
            const o = record(value, ['schema', 'pdf', 'pages']);
            if (o.schema !== 1 || !(o.pdf instanceof Blob) || o.pdf.size < 1 || o.pdf.size > MAX_FILE) invalidPdfReply();
            const pages = list(o.pages, MAX_PAGES);
            if (pages.length !== input.pages.length) invalidPdfReply();
            const seen = new Set<number>();
            result = { schema: 1, pdf: o.pdf.slice(0, o.pdf.size, o.pdf.type), pages: pages.map((value, index) => {
                const page = record(value, ['sourcePage', 'inkPage', 'width', 'height', 'hash']);
                const sourcePage = integer(page.sourcePage, 0, MAX_PAGES - 1), inkPage = integer(page.inkPage, 0, MAX_PAGES - 1);
                if (seen.has(sourcePage)) invalidPdfReply();
                seen.add(sourcePage);
                const width = finite(page.width, 1, 14_400), height = finite(page.height, 1, 14_400);
                exact(sourcePage, input.pages[index].sourcePage); exact(inkPage, index);
                exact(width, input.pages[index].width); exact(height, input.pages[index].height);
                return { sourcePage, inkPage, width, height, hash: fingerprint(page.hash) };
            }) };
            break;
        }
        case 'writer.stageAnnotated': {
            const o = record(value, ['stageId', 'sourceFingerprint', 'geometryEngine']);
            const engine = record(o.geometryEngine, ['id', 'build', 'generation']);
            const engineId = text(engine.id, 1024), build = text(engine.build, 1024);
            if (!engineId || !build) invalidPdfReply();
            result = { stageId: id(o.stageId), sourceFingerprint: fingerprint(o.sourceFingerprint),
                geometryEngine: { id: engineId, build, generation: integer(engine.generation, 0, Number.MAX_SAFE_INTEGER) } };
            break;
        }
        case 'writer.finishAnnotated': {
            const input = args as WriterOperations['writer.finishAnnotated']['args'];
            const o = record(value, ['bytes', 'revision', 'writeId', 'sourceFingerprint', 'verification']);
            const v = record(o.verification, ['pageCount', 'attachmentCount', 'writeMark']);
            if (v.writeMark !== 'verified') invalidPdfReply();
            result = { bytes: outputBytes(o.bytes), revision: revision(o.revision, input.revision), writeId: writeId(o.writeId, input.writeId),
                sourceFingerprint: fingerprint(o.sourceFingerprint), verification: { pageCount: integer(v.pageCount, 1, MAX_PAGES),
                    attachmentCount: integer(v.attachmentCount, 1, MAX_ATTACHMENTS), writeMark: 'verified' } };
            break;
        }
        case 'writer.buildNotebook': {
            const input = args as WriterOperations['writer.buildNotebook']['args'];
            const o = record(value, ['bytes', 'revision', 'writeId', 'verification']);
            const v = record(o.verification, ['pageCount', 'attachmentCount']);
            const pageCount = integer(v.pageCount, 1, MAX_PAGES), attachmentCount = integer(v.attachmentCount, 0, MAX_ATTACHMENTS);
            exact(pageCount, input.pages.length); exact(attachmentCount, 1);
            result = { bytes: outputBytes(o.bytes), revision: revision(o.revision, input.revision), writeId: writeId(o.writeId, input.writeId),
                verification: { pageCount, attachmentCount } };
            break;
        }
        case 'writer.rotate': {
            const input = args as WriterOperations['writer.rotate']['args'];
            const o = record(value, ['bytes', 'sourceFingerprint', 'geometries']);
            const sourceFingerprint = fingerprint(o.sourceFingerprint); exact(sourceFingerprint, input.source.pristineFingerprint);
            const pages = geometries(o.geometries);
            if (!pages.length || input.pageIndices?.some(index => !Number.isSafeInteger(index) || index < 0 || index >= pages.length)) invalidPdfReply();
            result = { bytes: outputBytes(o.bytes), sourceFingerprint, geometries: pages };
            break;
        }
        case 'writer.release': record(value, []); result = {}; break;
        default: return invalidPdfReply();
    }
    return result as WriterOperations[K]['result'];
}
