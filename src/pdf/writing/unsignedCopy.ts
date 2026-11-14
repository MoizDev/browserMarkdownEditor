import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFSignature, PDFString } from 'pdf-lib';
import type { PDFObject, PDFPage } from 'pdf-lib';
import type { WorkerContext } from '../../platform/workers/serve';
import { boundedAttachmentBytes, inventoryAttachments } from '../../utils/pdfAttachmentTree';
import { Sha256 } from '../../utils/sha256';
import { inspectPdfDocumentWriteSafety } from '../../utils/pdfWriteSafety';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { WriterNativeDocument } from './nativeStage';
import type { WriterOperations } from './protocol';

const key = PDFName.of;
const ATTACHMENT = 'Signed source.pdf';
function refuse(why: string): never { throw new Error(`Unsigned copy unavailable: ${why}`); }
const memoryBlob = (value: unknown): value is Blob => value instanceof Blob &&
    !(typeof File !== 'undefined' && value instanceof File) && value.size > 0 && value.size < 0x80000000;
async function hash(bytes: Uint8Array, ctx: WorkerContext): Promise<string> {
    const digest = new Sha256();
    for (let i = 0; i < bytes.length; i += 1024 * 1024) { await ctx.slice(); digest.update(bytes.subarray(i, i + 1024 * 1024)); }
    return digest.digest();
}
function numbers(value: unknown, length: number): number[] {
    if (!(value instanceof PDFArray) || value.size() !== length) return refuse('invalid signature appearance geometry');
    return Array.from({ length }, (_, index) => {
        const n = value.lookup(index);
        if (!(n instanceof PDFNumber) || !Number.isFinite(n.asNumber())) return refuse('invalid signature appearance geometry');
        return n.asNumber();
    });
}
function noAssociations(doc: PDFDocument): void {
    const seen = new Set<PDFObject>(), todo: PDFObject[] = doc.context.enumerateIndirectObjects().map(([, obj]) => obj);
    while (todo.length) {
        const value = todo.pop()!;
        if (seen.has(value)) continue;
        seen.add(value);
        if (seen.size > 1_000_000) refuse('object graph is too large');
        const dict = value instanceof PDFRawStream ? value.dict : value instanceof PDFDict ? value : undefined;
        if (dict) {
            if (dict.has(key('AF'))) refuse('associated files need preservation beyond this safe path');
            for (const [, child] of dict.entries()) if (!(child instanceof PDFRef)) todo.push(child);
        } else if (value instanceof PDFArray) {
            for (let i = 0; i < value.size(); i++) { const child = value.get(i); if (!(child instanceof PDFRef)) todo.push(child); }
        }
    }
}
function noAttachmentNamespace(doc: PDFDocument): void {
    const names = doc.catalog.lookup(key('Names'));
    if (names !== undefined && !(names instanceof PDFDict)) refuse('invalid Names dictionary');
    if (names instanceof PDFDict && names.has(key('EmbeddedFiles'))) refuse('existing attachments require a preservation-aware conversion');
    noAssociations(doc);
    if (inventoryAttachments(doc).length) refuse('existing attachments require a preservation-aware conversion');
}
async function load(source: Blob, ctx: WorkerContext): Promise<{ doc: PDFDocument; bytes: Uint8Array }> {
    if (!memoryBlob(source)) return refuse('invalid memory-backed source');
    await ctx.slice();
    const bytes = new Uint8Array(await source.arrayBuffer());
    await ctx.slice();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity });
    if (doc.isEncrypted) refuse('encrypted PDFs cannot be converted');
    return { doc, bytes };
}

// Stream dictionaries are traversed, but compressed stream bytes (including the
// eventual signed-source attachment) are never interpreted as outer objects.
function walkOuter(doc: PDFDocument, visit: (value: PDFObject, parent?: PDFObject) => void): void {
    const seen = new Set<PDFObject>(), todo = doc.context.enumerateIndirectObjects().map(([, value]) => ({ value, parent: undefined as PDFObject | undefined }));
    while (todo.length) {
        const { value, parent } = todo.pop()!;
        visit(value, parent);
        if (value instanceof PDFRef || seen.has(value)) continue;
        seen.add(value);
        if (seen.size > 1_000_000 || todo.length > 1_000_000) refuse('object graph is too large');
        const dict = value instanceof PDFRawStream ? value.dict : value instanceof PDFDict ? value : undefined;
        if (dict) for (const [, child] of dict.entries()) todo.push({ value: child, parent: value });
        else if (value instanceof PDFArray) for (let i = 0; i < value.size(); i++) todo.push({ value: value.get(i), parent: value });
    }
}

/** The admitted form is deliberately narrow: no non-signature content is flattened. */
function flattenSignatures(doc: PDFDocument, sourceSize: number): void {
    if (doc.catalog.has(key('StructTreeRoot')) || doc.catalog.has(key('MarkInfo')) || doc.catalog.has(key('Perms'))) refuse('tagged or certified PDF');
    const acro = doc.catalog.lookup(key('AcroForm'));
    if (!(acro instanceof PDFDict) || acro.has(key('XFA'))) refuse('missing or XFA form');
    const flags = acro.lookup(key('SigFlags'));
    if (flags !== undefined && (!(flags instanceof PDFNumber) || !Number.isInteger(flags.asNumber()) || flags.asNumber() < 0 || flags.asNumber() > 3)) refuse('unsupported signature flags');
    const roots = acro.lookup(key('Fields'));
    if (!(roots instanceof PDFArray) || !roots.size() || roots.size() > 10_000) refuse('ambiguous signature field tree');
    const form = doc.getForm(), fields = form.getFields();
    if (fields.length !== roots.size() || fields.some(field => !(field instanceof PDFSignature))) refuse('mixed or unsupported form fields');
    const byRef = new Map(fields.map(field => [field.ref.toString(), field]));
    if (byRef.size !== fields.length) refuse('duplicate signature fields');
    const captured: Array<{ page: PDFPage; ref: PDFRef }> = [];
    const signatureRefs = new Map<string, PDFRef>(), knownSignatures = new Set<PDFDict>();
    for (let i = 0; i < roots.size(); i++) {
        const ref = roots.get(i);
        if (!(ref instanceof PDFRef)) refuse('direct signature field');
        const field = byRef.get(ref.toString());
        if (!(field instanceof PDFSignature)) refuse('ambiguous signature field');
        const dict = field.acroField.dict;
        if (dict.has(key('Kids')) || dict.has(key('Parent')) || dict.has(key('Lock')) || dict.has(key('OC')) ||
            dict.lookup(key('Subtype')) !== key('Widget')) refuse('signature widget is not an unambiguous merged field');
        const signatureRef = dict.get(key('V'));
        if (!(signatureRef instanceof PDFRef) || signatureRefs.has(signatureRef.toString())) refuse('signature value is direct or shared');
        const signature = doc.context.lookup(signatureRef);
        if (!(signature instanceof PDFDict) || signature.has(key('Reference')) || knownSignatures.has(signature)) refuse('signature policy is ambiguous');
        signatureRefs.set(signatureRef.toString(), signatureRef);
        knownSignatures.add(dict);
        knownSignatures.add(signature);
        const range = numbers(signature.lookup(key('ByteRange')), 4);
        if (range.some(n => !Number.isSafeInteger(n) || n < 0) || range[0] !== 0 || range[1] > range[2] ||
            range[2] + range[3] > sourceSize) refuse('signature byte range is invalid');
        const contents = signature.lookup(key('Contents'));
        if (!(contents instanceof PDFHexString || contents instanceof PDFString) || !contents.asBytes().length) refuse('signature contents are missing');
        const flags = dict.lookup(key('F'));
        if (!(flags instanceof PDFNumber) || flags.asNumber() !== 4) refuse('signature visibility or print flags are unsupported');
        const mk = dict.lookup(key('MK'));
        if (mk !== undefined && (!(mk instanceof PDFDict) || mk.has(key('R')))) refuse('signature widget rotation is unsupported');
        const rect = numbers(dict.lookup(key('Rect')), 4), width = rect[2] - rect[0], height = rect[3] - rect[1];
        if (width <= 0 || height <= 0) refuse('signature widget rectangle is invalid');
        const ap = dict.lookup(key('AP'));
        if (!(ap instanceof PDFDict)) refuse('signature appearance is missing');
        const normalRef = ap.get(key('N'));
        if (!(normalRef instanceof PDFRef)) refuse('signature appearance is ambiguous');
        const normal = doc.context.lookup(normalRef);
        if (!(normal instanceof PDFRawStream) || normal.dict.lookup(key('Subtype')) !== key('Form')) refuse('signature appearance is not a Form');
        const bbox = numbers(normal.dict.lookup(key('BBox')), 4), matrix = normal.dict.lookup(key('Matrix'));
        if (bbox[0] !== 0 || bbox[1] !== 0 || bbox[2] !== width || bbox[3] !== height ||
            (matrix !== undefined && numbers(matrix, 6).some((n, j) => n !== [1, 0, 0, 1, 0, 0][j]))) refuse('signature appearance placement is unsupported');
        const pageRef = dict.get(key('P'));
        const page = doc.getPages().find(item => item.ref === pageRef);
        if (!page) refuse('signature widget page is ambiguous');
        const resources = page.node.get(key('Resources'));
        if (!(resources instanceof PDFDict)) refuse('shared or inherited page resources');
        const objects = resources.get(key('XObject'));
        if (objects !== undefined && !(objects instanceof PDFDict)) refuse('shared page XObject resources');
        captured.push({ page, ref });
    }
    const expected = new Set(captured.map(item => item.ref.toString()));
    if ([...signatureRefs.keys()].some(ref => expected.has(ref))) refuse('signature field and value objects overlap');
    let count = 0;
    for (const page of doc.getPages()) {
        const annots = page.node.lookup(key('Annots'));
        if (annots === undefined) continue;
        if (!(annots instanceof PDFArray)) refuse('invalid page annotations');
        for (let i = 0; i < annots.size(); i++) {
            const ref = annots.get(i);
            if (!(ref instanceof PDFRef) || !expected.has(ref.toString()) || !captured.some(item => item.page === page && item.ref === ref)) refuse('other or ambiguous annotations');
            count++;
        }
    }
    if (count !== captured.length) refuse('signature annotation is missing or duplicated');
    const admittedRefs = new Set([...signatureRefs.keys(), ...expected]);
    // Aliased indirect objects or unrecognized signature dictionaries cannot be
    // attributed to a widget and must not be deleted as collateral.
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
        if (object instanceof PDFDict && knownSignatures.has(object) && !admittedRefs.has(ref.toString())) refuse('signature object has an ambiguous alias');
    }
    walkOuter(doc, value => {
        const dict = value instanceof PDFRawStream ? value.dict : value instanceof PDFDict ? value : undefined;
        if (dict && (dict.has(key('ByteRange')) || dict.lookup(key('Type')) === key('Sig') || dict.lookup(key('FT')) === key('Sig')) &&
            !knownSignatures.has(dict)) refuse('unmapped signature data');
    });
    form.flatten({ updateFieldAppearances: false });
    for (const item of captured) item.page.node.removeAnnot(item.ref);
    acro.delete(key('SigFlags'));
    // Only now can we prove the admitted value objects are obsolete. Do not
    // delete a value still named by any surviving outer object.
    walkOuter(doc, (value, parent) => {
        if (value instanceof PDFRef && admittedRefs.has(value.toString()) ||
            parent && value instanceof PDFDict && knownSignatures.has(value)) refuse('signature object is still referenced');
    });
    for (const ref of signatureRefs.values()) doc.context.delete(ref);
}

async function geometries(runtime: PdfiumRuntime, bytes: Uint8Array, requireSigned: boolean, ctx: WorkerContext) {
    const document = WriterNativeDocument.openBytes(runtime, bytes);
    try {
        const signatures = runtime.call('FPDF_GetSignatureCount', document.handle), formType = runtime.call('FPDF_GetFormType', document.handle);
        if (!Number.isSafeInteger(signatures) || (requireSigned ? signatures < 1 : signatures !== 0) ||
            runtime.call('FPDF_GetSecurityHandlerRevision', document.handle) !== -1 || !Number.isSafeInteger(formType) || formType < 0 || formType > 1) refuse('native signature, encryption or form status is unsafe');
        const pages = [];
        for (let i = 0, count = document.pageCount(); i < count; i++) {
            await ctx.slice();
            const size = pdfiumPageSize(runtime, document.handle, i, 14_400), handle = runtime.call('FPDF_LoadPage', document.handle, i) >>> 0;
            if (!handle) refuse('page geometry is unavailable');
            try { pages.push(pdfiumPageGeometry(runtime, handle, i, size)); } finally { runtime.call('FPDF_ClosePage', handle); }
        }
        return pages;
    } finally { document.close(); }
}
export async function prepareUnsignedCopy(args: WriterOperations['writer.prepareUnsignedCopy']['args'], ctx: WorkerContext) {
    const { doc, bytes } = await load(args.source, ctx);
    noAttachmentNamespace(doc);
    flattenSignatures(doc, bytes.length);
    const originalSha = await hash(bytes, ctx);
    await doc.attach(bytes, ATTACHMENT, { mimeType: 'application/pdf', description: 'Original signed PDF; signatures apply to this attachment, not this unsigned copy.' });
    await ctx.slice();
    const output = await doc.save({ objectsPerTick: Infinity, updateFieldAppearances: false });
    await ctx.slice();
    const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
    ctx.transfer(buffer);
    return { bytes: buffer, originalSha, attachmentName: ATTACHMENT };
}
export async function verifyUnsignedCopy(runtime: PdfiumRuntime, args: WriterOperations['writer.verifyUnsignedCopy']['args'], ctx: WorkerContext) {
    if (!(args.bytes instanceof ArrayBuffer) || args.bytes.byteLength < 8 || args.bytes.byteLength >= 0x80000000 || args.attachmentName !== ATTACHMENT) refuse('invalid verification input');
    const source = await load(args.source, ctx);
    noAttachmentNamespace(source.doc);
    flattenSignatures(source.doc, source.bytes.length);
    const sourceGeometry = await geometries(runtime, source.bytes, true, ctx), originalSha = await hash(source.bytes, ctx);
    const output = new Uint8Array(args.bytes), outputSha = await hash(output, ctx);
    const check = await PDFDocument.load(output, { updateMetadata: false, parseSpeed: Infinity });
    if (inspectPdfDocumentWriteSafety(check).kind !== 'safe') refuse('output write safety could not be established');
    const form = check.catalog.lookup(key('AcroForm'));
    if (check.catalog.has(key('Perms')) || (form !== undefined && (!(form instanceof PDFDict) || form.has(key('SigFlags')) ||
        form.has(key('XFA')) || !(form.lookup(key('Fields')) instanceof PDFArray) || (form.lookup(key('Fields')) as PDFArray).size() !== 0))) {
        refuse('output still contains signature or form authority');
    }
    const entries = inventoryAttachments(check);
    if (check.isEncrypted || entries.length !== 1 || entries[0].keys.length !== 1 || entries[0].names.size !== 1 ||
        !entries[0].names.has(ATTACHMENT) || !entries[0].associated || entries[0].description.startsWith('local-vault-pdf/')) refuse('output attachment inventory is not exact');
    const ef = entries[0].spec.lookup(key('EF'));
    if (!(ef instanceof PDFDict)) refuse('signed source attachment is unreadable');
    const f = ef.lookup(key('F')), uf = ef.lookup(key('UF'));
    if (!(f instanceof PDFRawStream) || uf && uf !== f) refuse('signed source attachment is ambiguous');
    const retained = boundedAttachmentBytes(f, 0x7fffffff);
    if (await hash(retained, ctx) !== originalSha) refuse('signed source attachment fingerprint changed');
    const outputGeometry = await geometries(runtime, output, false, ctx);
    if (sourceGeometry.length !== outputGeometry.length || sourceGeometry.some((page, i) => {
        const other = outputGeometry[i];
        return page.index !== other.index || page.width !== other.width || page.height !== other.height || page.rotate !== other.rotate ||
            page.userUnit !== other.userUnit || page.toUserSpace.some((n, j) => n !== other.toUserSpace[j]);
    })) refuse('output page geometry changed');
    await ctx.slice();
    ctx.transfer(args.bytes);
    return { bytes: args.bytes, originalSha, outputSha };
}
