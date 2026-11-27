import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
import type { WorkerContext } from '../../platform/workers/serve';
import { asQuarter } from '../../utils/pdfRotation';
import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { pdfiumPageSize } from '../engine/pdfium/geometry';
import { WriterNativeDocument } from './nativeStage';
import { PdfObjectReader } from './rotationReader';
import type { PdfValue } from './rotationReader';
import { readOwnRotationSection, readPageTree } from './rotationUpdate';

const nameText = (name: PDFName) => name.asString().slice(1).replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

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
export const fail = (message: string) => new PdfEngineError('InvalidPdf', `Rotated PDF failed verification: ${message}`);

export interface TurnSection {
    read(bytes: Uint8Array): Promise<{ base: number; objects: ReadonlySet<number> } | null>;
    readonly extra: ReadonlySet<number>;
}
export const PAGE_TURN: TurnSection = {
    async read(bytes) { const own = await readOwnRotationSection(bytes); return own && { base: own.base, objects: new Set(own.objects.keys()) }; },
    extra: new Set(),
};

export async function verifyPageTurn(runtime: PdfiumRuntime, input: Uint8Array, output: Uint8Array, base: number, expected: readonly number[],
    context: WorkerContext, own: TurnSection): Promise<void> {
    if (!Number.isSafeInteger(base) || base <= 0 || base > input.length || base > output.length || !Array.isArray(expected)) throw fail('the prefix length is invalid');
    for (let i = 0; i < base; i += 1 << 22) {
        await context.slice();
        const end = Math.min(base, i + (1 << 22));
        for (let j = i; j < end; j++) if (input[j] !== output[j]) throw fail('the original bytes are not an exact prefix');
    }
    if (base < input.length && (await own.read(input))?.base !== base) throw fail('the replaced section was not this writer’s');
    const section = output.length > base ? await own.read(output) : null;
    if (output.length > base && section?.base !== base) throw fail('the appended section is not in the expected shape');
    const redefined = new Set(section ? section.objects : []);
    for (const num of own.extra) {
        if (section && !redefined.delete(num)) throw fail('the appended section leaves out an object it must replace');
    }
    await context.slice();
    const prefix = input.subarray(0, base);
    const oldPages = await readPageTree(await PdfObjectReader.open(prefix), () => context.slice());
    const after = await load(output);
    await context.slice();
    const newPages = after.getPages();
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
}

