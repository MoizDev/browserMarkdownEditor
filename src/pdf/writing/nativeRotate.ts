import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import type { WorkerContext } from '../../platform/workers/serve';
import { inspectPdfRole } from '../../utils/pdfAttachmentInventory';
import { canRotatePdfRole } from '../../utils/pdfRole';
import { asQuarter } from '../../utils/pdfRotation';
import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { pdfiumPageSize } from '../engine/pdfium/geometry';
import { WriterNativeDocument } from './nativeStage';
import { PdfObjectReader, PdfSyntaxError } from './rotationReader';
import type { PdfValue } from './rotationReader';
import { planRotation, readOwnRotationSection, readPageTree } from './rotationUpdate';
import type { RotationRefusal, WriterOperations } from './protocol';

type Rotate = WriterOperations['writer.rotate'];
type Verify = WriterOperations['writer.verifyRotation'];

function refusal(cause: RotationRefusal): Rotate['result'] { return { kind: 'refused', cause }; }

/** Builds the appended section in the writer worker. The safety gates are the ones every
 * rotation always had (role plain, outer write safety 'safe'); only the write itself changed. */
export async function rotateNativePdf(args: Rotate['args'], context: WorkerContext): Promise<Rotate['result']> {
    if (!(args.source instanceof Blob) || !args.source.size || args.source.size >= 0x80000000) throw new PdfEngineError('InvalidPdf', 'Invalid rotation source');
    const bytes = new Uint8Array(await args.source.arrayBuffer());
    await context.slice();
    const role = await inspectPdfRole(bytes, '');
    await context.slice();
    const safety = role.writeSafety;
    if (safety.kind === 'signed') return refusal('signed');
    if (safety.kind === 'encrypted' || role.kind === 'unreadable' && role.reason === 'encrypted') return refusal('encrypted');
    if (role.kind === 'annotated' || role.kind === 'newer') return refusal('annotated');
    if (role.kind === 'notebookExport') return refusal('notebook-source');
    if (role.kind === 'unreadable' || role.kind === 'ambiguous') return refusal('missing-attachment');
    if (safety.kind !== 'safe') return refusal('unsafe-policy');
    if (!canRotatePdfRole(role)) return refusal('unsafe-policy');
    try {
        const plan = await planRotation(bytes, args.turns, () => context.slice());
        if (!plan) return { kind: 'unchanged' };
        const appendix = plan.appendix.slice().buffer;
        context.transfer(appendix);
        return { kind: 'update', appendix, base: plan.base, pageCount: plan.pageCount, before: plan.before, rotations: plan.rotations };
    } catch (error) {
        if (error instanceof PdfSyntaxError) return refusal(/rotation/.test(error.message) ? 'unsupported-rotation' : 'unsupported-format');
        throw error;
    }
}

const nameText = (name: PDFName) => name.asString().slice(1).replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** pdf-lib's view of a value, spelled canonically: two spellings of one value compare equal. */
function canonical(value: PDFObject | undefined, depth = 0): string {
    if (depth > 64) throw new PdfEngineError('InvalidPdf', 'PDF page value nesting exceeds its limit');
    if (value === undefined) return 'undefined';
    if (value instanceof PDFName) return `n:${JSON.stringify(nameText(value))}`;
    if (value instanceof PDFNumber) return `#:${value.asNumber()}`;
    if (value instanceof PDFString || value instanceof PDFHexString) return `s:${hex(value.asBytes())}`;
    if (value instanceof PDFRef) return `r:${value.objectNumber}.${value.generationNumber}`;
    if (value instanceof PDFBool) return `b:${value.asBoolean()}`;
    if (value === PDFNull) return 'null';
    if (value instanceof PDFArray) return `[${value.asArray().map(item => canonical(item, depth + 1)).join(',')}]`;
    if (value instanceof PDFDict) {
        return `{${value.entries().map(([key, item]) => `${JSON.stringify(nameText(key))}=${canonical(item, depth + 1)}`).sort().join(',')}}`;
    }
    throw new PdfEngineError('InvalidPdf', 'Unexpected PDF page value');
}
/** The same spelling for this writer's own reader, so the two parsers can be compared value for value. */
function canonicalValue(value: PdfValue, depth = 0): string {
    if (depth > 64) throw new PdfEngineError('InvalidPdf', 'PDF page value nesting exceeds its limit');
    switch (value.kind) {
        case 'name': return `n:${JSON.stringify(value.value)}`;
        case 'number': return `#:${value.value}`;
        case 'string': return `s:${hex(value.bytes)}`;
        case 'ref': return `r:${value.num}.${value.gen}`;
        case 'bool': return `b:${value.value}`;
        case 'null': return 'null';
        case 'array': return `[${value.items.map(item => canonicalValue(item, depth + 1)).join(',')}]`;
        case 'dict': return `{${[...value.entries].map(([key, item]) => `${JSON.stringify(key)}=${canonicalValue(item, depth + 1)}`).sort().join(',')}}`;
        case 'keyword': throw new PdfEngineError('InvalidPdf', 'Unexpected PDF keyword in a page');
    }
}
function pageFields(dict: PDFDict): string {
    return `{${dict.entries().filter(([key]) => nameText(key) !== 'Rotate')
        .map(([key, item]) => `${JSON.stringify(nameText(key))}=${canonical(item)}`).sort().join(',')}}`;
}
async function load(bytes: Uint8Array): Promise<PDFDocument> {
    return PDFDocument.load(bytes, { parseSpeed: Infinity, updateMetadata: false, throwOnInvalidObject: true });
}
const fail = (message: string) => new PdfEngineError('InvalidPdf', `Rotated PDF failed verification: ${message}`);

/**
 * A fresh writer proves the result before App may write it, with readers other than the one that built it:
 * (1) the result begins with the source's bytes, exactly; (2) whatever follows them is one section in this
 * writer's shape, redefining only page objects; (3) pdf-lib, reading the whole result, finds every page as
 * this writer's reader finds it in the untouched prefix but for /Rotate, at exactly the expected angles, and
 * nothing turned that should not be; (4) PDFium opens it with the same page count, and on a sample of pages
 * reads each size swapped or kept as its turn says and the expected /Rotate. The write safety of the
 * prefix was established by the planner; (3) proves the section adds nothing that could change it.
 */
export async function verifyNativeRotation(runtime: PdfiumRuntime, args: Verify['args'], context: WorkerContext): Promise<Verify['result']> {
    if (!(args.source instanceof Blob) || !(args.bytes instanceof ArrayBuffer)) throw new PdfEngineError('InvalidPdf', 'Invalid rotation verification');
    const input = new Uint8Array(await args.source.arrayBuffer()), output = new Uint8Array(args.bytes), base = args.base;
    if (!Number.isSafeInteger(base) || base <= 0 || base > input.length || base > output.length || !Array.isArray(args.rotations)) throw fail('the prefix length is invalid');
    for (let i = 0; i < base; i += 1 << 22) {
        await context.slice();
        const end = Math.min(base, i + (1 << 22));
        for (let j = i; j < end; j++) if (input[j] !== output[j]) throw fail('the original bytes are not an exact prefix');
    }
    if (base < input.length && (await readOwnRotationSection(input))?.base !== base) throw fail('the replaced section was not this writer’s');
    const section = output.length > base ? await readOwnRotationSection(output) : null;
    if (output.length > base && section?.base !== base) throw fail('the appended section is not in the expected shape');
    const redefined = new Set(section ? section.objects.keys() : []);
    await context.slice();
    // Two different parsers: this writer's own reads the untouched prefix, pdf-lib the whole result.
    const prefix = input.subarray(0, base);
    const oldPages = await readPageTree(await PdfObjectReader.open(prefix), () => context.slice());
    const after = await load(output);
    await context.slice();
    const newPages = after.getPages(), expected = args.rotations;
    if (!oldPages.length || oldPages.length !== newPages.length || expected.length !== newPages.length) throw fail('the page count changed');
    const turned = new Set<number>(), turnedPages: number[] = [];
    for (let i = 0; i < newPages.length; i++) {
        if (i % 256 === 0) await context.slice();
        const was = oldPages[i], now = newPages[i];
        if (was.num !== now.ref.objectNumber || was.gen !== now.ref.generationNumber) throw fail(`page ${i + 1} moved`);
        const angle = asQuarter(now.getRotation().angle);
        if (angle !== expected[i]) throw fail(`page ${i + 1} is at ${angle}°, not ${expected[i]}°`);
        if (angle !== was.rotate) { turned.add(was.num); turnedPages.push(i); }
        const fields = new Map(was.dict.entries);
        fields.delete('Rotate');
        if (canonicalValue({ kind: 'dict', entries: fields }) !== pageFields(now.node)) throw fail(`page ${i + 1} changed beyond its rotation`);
    }
    if (turned.size !== redefined.size || [...redefined].some(num => !turned.has(num))) throw fail('the appended objects are not exactly the turned pages');
    await context.slice();
    const native = WriterNativeDocument.openBytes(runtime, output), original = WriterNativeDocument.openBytes(runtime, prefix);
    try {
        native.assertEditable();
        const count = native.pageCount();
        if (count !== original.pageCount() || count !== expected.length) throw fail('PDFium reads a different page count');
        // Loading a page parses its content, so PDFium's own reading is checked on a bounded, spread sample: up to 24
        // turned pages (size swapped or kept as the turn says, and the exact /Rotate) and 8 untouched ones (size kept).
        // pdf-lib has already checked every page.
        const untouched = oldPages.flatMap((_, i) => turned.has(oldPages[i].num) ? [] : [i]);
        const spread = (list: number[], max: number) => list.filter((_, k) => k % Math.max(1, Math.ceil(list.length / max)) === 0);
        for (const index of [...spread(turnedPages, 24), ...spread(untouched, 8)]) {
            await context.slice();
            const a = pdfiumPageSize(runtime, original.handle, index, 14_400), b = pdfiumPageSize(runtime, native.handle, index, 14_400);
            const odd = ((expected[index] - oldPages[index].rotate) / 90) % 2 !== 0;
            const [w, h] = odd ? [a.height, a.width] : [a.width, a.height];
            if (Math.abs(w - b.width) > 0.01 || Math.abs(h - b.height) > 0.01) throw fail(`PDFium sizes page ${index + 1} unexpectedly`);
            if (expected[index] === oldPages[index].rotate) continue;
            const page = runtime.call('FPDF_LoadPage', native.handle, index) >>> 0;
            if (!page) throw fail(`PDFium cannot open page ${index + 1}`);
            try { if (runtime.call('FPDFPage_GetRotation', page) * 90 !== expected[index]) throw fail(`PDFium reads page ${index + 1} at another angle`); }
            finally { runtime.call('FPDF_ClosePage', page); }
        }
    } finally { native.close(); original.close(); }
    context.transfer(args.bytes);
    return { bytes: args.bytes, pageCount: expected.length };
}
