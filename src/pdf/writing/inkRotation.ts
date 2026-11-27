import { PDFDocument } from 'pdf-lib';
import type { WorkerContext } from '../../platform/workers/serve';
import { checkPdfWriteMarkForBoard, pdfWriteMarkV2Placeholder, sealPdfWriteMark } from '../../utils/pdfWriteMark';
import { Sha256 } from '../../utils/sha256';
import { asQuarter } from '../../utils/pdfRotation';
import type { PageGeometry } from '../../platform/types';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { PdfEngineError } from '../engine/types';
import { BoardTurnRefused, turnBoardText } from './inkBoardTurn';
import { PdfInkInspector } from './inkInspection';
import type { PdfInkInspection } from './inkInspection.types';
import { WriterNativeDocument } from './nativeStage';
import type { RotationRefusal, WriterOperations, WriterSource } from './protocol';
import { InexactTurn, quarters } from './quarterTurn';
import { PdfObjectReader, PdfSyntaxError, dictGet, readStartXref } from './rotationReader';
import type { PdfValue } from './rotationReader';
import { appendObjects, planRotation, readAppendedSection, readPageTree, turnedDictionary } from './rotationUpdate';
import { PAGE_TURN, verifyPageTurn } from './rotationVerify';
import type { ObjectBody, PdfRotationPage, RotationTurns } from './rotationUpdate';
import { newPdfWriteId, WRITE_MARK_ATTACHMENT } from './writeIdentity';

export const INK_ROTATION_MARK = '%local-vault-pdf/v1;ink-rotation;base=';
const NAMES = ['original.pdf', 'board.json', WRITE_MARK_ATTACHMENT] as const;
type Engine = WriterSource['geometryEngine'];
type Rotate = WriterOperations['writer.rotate']['result'];

const encoder = new TextEncoder();
const fail = (message: string) => new PdfEngineError('InvalidPdf', `Rotated PDF failed verification: ${message}`);
class Refused extends Error { constructor(readonly cause: RotationRefusal) { super(cause); } }

function hash(bytes: Uint8Array): string {
    const digest = new Sha256();
    for (let at = 0; at < bytes.length; at += 1 << 20) digest.update(bytes.subarray(at, at + (1 << 20)));
    return digest.digest();
}

function inspectionRefusal(inspection: Exclude<PdfInkInspection, { kind: 'native' }>): RotationRefusal {
    if (inspection.kind === 'plain') return 'unsupported-format';
    switch (inspection.reason) {
        case 'signed': return 'signed';
        case 'encrypted': return 'encrypted';
        case 'unsafe-policy': return 'unsafe-policy';
        case 'unsupported-format': case 'invalid-marker': return 'newer-annotations';
        case 'invalid-write-mark': return 'foreign-change';
        case 'missing-attachment': return 'missing-attachment';
        default: return 'unverified';
    }
}

function pdfText(value: PdfValue | undefined): string | undefined {
    if (value?.kind !== 'string') return undefined;
    const b = value.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
        let text = '';
        for (let i = 2; i + 1 < b.length; i += 2) text += String.fromCharCode(b[i] << 8 | b[i + 1]);
        return text;
    }
    return String.fromCharCode(...b);
}

async function attachmentStreams(reader: PdfObjectReader): Promise<Map<string, { num: number; gen: number }>> {
    const found = new Map<string, { num: number; gen: number }>();
    const root = await reader.resolve(dictGet(reader.last.trailer, 'Root'));
    const names = root?.kind === 'dict' ? await reader.resolve(dictGet(root, 'Names')) : undefined;
    const tree = names?.kind === 'dict' ? dictGet(names, 'EmbeddedFiles') : undefined;
    if (!tree) throw new PdfSyntaxError('PDF has no embedded files');
    const pending: Array<{ value: PdfValue; depth: number }> = [{ value: tree, depth: 0 }];
    let visited = 0;
    while (pending.length) {
        const { value, depth } = pending.pop()!;
        const node = await reader.resolve(value);
        if (node?.kind !== 'dict' || depth > 64 || ++visited > 100_000) throw new PdfSyntaxError('PDF embedded files are unreadable');
        const pairs = await reader.resolve(dictGet(node, 'Names')), kids = await reader.resolve(dictGet(node, 'Kids'));
        if (pairs?.kind === 'array') for (let i = 0; i + 1 < pairs.items.length; i += 2) {
            const name = pdfText(await reader.resolve(pairs.items[i]));
            if (!name || !(NAMES as readonly string[]).includes(name)) continue;
            const spec = await reader.resolve(pairs.items[i + 1]);
            const ef = spec?.kind === 'dict' ? await reader.resolve(dictGet(spec, 'EF')) : undefined;
            const f = ef?.kind === 'dict' ? dictGet(ef, 'F') : undefined, uf = ef?.kind === 'dict' ? dictGet(ef, 'UF') : undefined;
            const stream = f ?? uf;
            if (found.has(name) || stream?.kind !== 'ref' || (f && uf && (f.kind !== 'ref' || uf.kind !== 'ref' || f.num !== uf.num || f.gen !== uf.gen))) {
                throw new PdfSyntaxError('PDF attachment streams are ambiguous');
            }
            found.set(name, { num: stream.num, gen: stream.gen });
        }
        if (kids?.kind === 'array') for (const kid of kids.items) pending.push({ value: kid, depth: depth + 1 });
    }
    if (NAMES.some(name => !found.has(name)) || new Set([...found.values()].map(entry => entry.num)).size !== NAMES.length) {
        throw new PdfSyntaxError('PDF attachment streams are missing');
    }
    return found;
}

async function ownInkSection(bytes: Uint8Array): Promise<{ base: number; pages: Map<number, number>; objects: Set<number> } | null> {
    const section = await readAppendedSection(bytes, INK_ROTATION_MARK);
    if (!section) return null;
    try {
        const prefix = await PdfObjectReader.open(bytes, section.base);
        const streams = await attachmentStreams(prefix), tree = await readPageTree(prefix);
        const byNum = new Map(tree.map(page => [page.num, page]));
        const pages = new Map<number, number>();
        const streamNums = new Set([...streams.values()].map(entry => entry.num));
        for (const [num, object] of section.objects) {
            if (streamNums.has(num)) {
                if (!object.stream || object.gen !== [...streams.values()].find(entry => entry.num === num)!.gen) return null;
                continue;
            }
            const page = byNum.get(num), rotate = dictGet(object.dict, 'Rotate');
            if (!page || object.stream || page.gen !== object.gen || rotate?.kind !== 'number' || rotate.value % 90 !== 0) return null;
            const a = new Map(page.dict.entries), b = new Map(object.dict.entries);
            a.delete('Rotate'); b.delete('Rotate');
            if (turnedDictionary({ ...page, dict: { kind: 'dict', entries: a } }, 0) !== turnedDictionary({ ...page, dict: { kind: 'dict', entries: b } }, 0)) return null;
            pages.set(num, asQuarter(rotate.value));
        }
        if ([...streamNums].some(num => !section.objects.has(num))) return null;
        return { base: section.base, pages, objects: new Set(section.objects.keys()) };
    } catch { return null; }
}

function turnedGeometries(runtime: PdfiumRuntime, bytes: Uint8Array, indices: readonly number[]): Map<number, PageGeometry> {
    const doc = WriterNativeDocument.openBytes(runtime, bytes), result = new Map<number, PageGeometry>();
    try {
        doc.assertEditable();
        for (const index of indices) {
            const size = pdfiumPageSize(runtime, doc.handle, index, 14_400), page = runtime.call('FPDF_LoadPage', doc.handle, index) >>> 0;
            if (!page) throw new PdfEngineError('PageError', 'Cannot inspect a turned page');
            try { result.set(index, pdfiumPageGeometry(runtime, page, index, size)); } finally { runtime.call('FPDF_ClosePage', page); }
        }
        return result;
    } finally { doc.close(); }
}

interface Basis {
    readonly base: number;
    readonly prefix: Uint8Array;
    readonly tree: PdfRotationPage[];
    readonly streams: Map<string, { num: number; gen: number }>;
    readonly pristine: Uint8Array;
    readonly pristineFingerprint: string;
    readonly board: string;
    readonly writeId: string;
    readonly current: number[];
}

async function basis(bytes: Uint8Array, slice: () => Promise<void>): Promise<Basis> {
    const own = await ownInkSection(bytes);
    const base = own ? own.base : bytes.length, prefix = bytes.subarray(0, base);
    const inspector = new PdfInkInspector();
    try {
        const inspection = await inspector.inspect(new Blob([prefix as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), slice);
        if (inspection.kind !== 'native') throw new Refused(inspectionRefusal(inspection));
        const reader = await PdfObjectReader.open(prefix);
        const tree = await readPageTree(reader, slice), streams = await attachmentStreams(reader);
        return { base, prefix, tree, streams, pristine: new Uint8Array(await inspection.pristine.arrayBuffer()),
            pristineFingerprint: inspection.pristineFingerprint, board: await inspection.board.text(), writeId: inspection.writeId,
            current: tree.map(page => own?.pages.get(page.num) ?? page.rotate) };
    } finally { inspector.dispose(); }
}

function engineOf(runtime: PdfiumRuntime): Engine {
    return { id: 'pdfium', build: `${runtime.buildId}/${runtime.artifactSha256}`, generation: 1 };
}

function sameEngine(value: unknown, engine: Engine): boolean {
    const v = value as Engine | undefined;
    return !!v && typeof v === 'object' && Object.keys(v).length === 3 && v.id === engine.id && v.build === engine.build && v.generation === engine.generation;
}

interface Turned { pristine: Uint8Array; pristineBase: number; board: string; writeId: string; rotations: number[] }

async function turnFromBasis(runtime: PdfiumRuntime, b: Basis, rotations: number[], engine: Engine, writeId: string,
    slice: () => Promise<void>): Promise<Turned> {
    const count = b.tree.length, base = b.tree.map(page => page.rotate);
    const q = rotations.map((angle, i) => quarters((angle - base[i]) / 90));
    const turns: RotationTurns = { all: 0, pages: q.flatMap((amount, i) => amount ? [[i, amount] as const] : []) };
    const plan = await planRotation(b.pristine, turns, slice);
    const pristine = plan ? new Uint8Array(plan.base + plan.appendix.length) : b.pristine;
    if (plan) { pristine.set(b.pristine.subarray(0, plan.base)); pristine.set(plan.appendix, plan.base); }
    if (!plan || plan.pageCount !== count || plan.rotations.some((angle, i) => angle !== rotations[i])) throw new Refused('unsupported-format');
    const indices = q.flatMap((amount, i) => amount ? [i] : []);
    const geometry = turnedGeometries(runtime, pristine, indices);
    await slice();
    const fingerprint = hash(pristine);
    const board = await turnBoardText(b.board, { quarters: q, host(fields, line) {
        const pdfSpan = fields.get('pdf'), pagesSpan = fields.get('pages');
        if (pdfSpan?.kind !== 'object' || pagesSpan?.kind !== 'array') throw new BoardTurnRefused('invalid');
        const pdf = JSON.parse(pdfSpan.text()) as Record<string, unknown>;
        const keys = Object.keys(pdf).sort().join(','), migration = pdf.migration as { previousFrames?: Array<{ width: number; height: number }> } | undefined;
        if ((keys !== 'geometryEngine,pages,schema,sourceFingerprint,writeId' && keys !== 'geometryEngine,migration,pages,schema,sourceFingerprint,writeId')
            || pdf.schema !== 1 || pdf.sourceFingerprint !== b.pristineFingerprint || pdf.writeId !== b.writeId
            || !Array.isArray(pdf.pages) || pdf.pages.length !== count
            || (migration && (!Array.isArray(migration.previousFrames) || migration.previousFrames.length !== count))) throw new BoardTurnRefused('invalid');
        if (!sameEngine(pdf.geometryEngine, engine)) throw new Refused('other-engine');
        const pages = (pdf.pages as Array<Record<string, unknown>>).map((page, i) => {
            const turned = geometry.get(i);
            if (!turned) return page;
            const was = page as { width: number; height: number };
            const [w, h] = q[i] % 2 ? [was.height, was.width] : [was.width, was.height];
            if (turned.width !== w || turned.height !== h) throw new BoardTurnRefused('invalid');
            return { index: turned.index, width: turned.width, height: turned.height, rotate: turned.rotate, userUnit: turned.userUnit, toUserSpace: [...turned.toUserSpace] };
        });
        const next = { schema: 1, sourceFingerprint: fingerprint, geometryEngine: pdf.geometryEngine, pages, writeId,
            ...(migration ? { migration: { ...migration, previousFrames: migration.previousFrames!.map((frame, i) =>
                q[i] % 2 ? { width: frame.height, height: frame.width } : frame) } } : {}) };
        const sizes = `[${pages.map(page => `[${JSON.stringify(page.width)},${JSON.stringify(page.height)}]`).join(',')}]`;
        return line.slice(0, pdfSpan.start) + JSON.stringify(next) + line.slice(pdfSpan.end, pagesSpan.start) + sizes + line.slice(pagesSpan.end);
    } }, slice);
    return { pristine, pristineBase: plan.base, board, writeId, rotations };
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
function streamBody(dict: string, data: Uint8Array): Uint8Array {
    const head = encoder.encode(`${dict}\nstream\n`), tail = encoder.encode('\nendstream'), out = new Uint8Array(head.length + data.length + tail.length);
    out.set(head); out.set(data, head.length); out.set(tail, head.length + data.length);
    return out;
}

async function section(b: Basis, turned: Turned): Promise<Uint8Array> {
    const reader = await PdfObjectReader.open(b.prefix);
    const objects: ObjectBody[] = b.tree.flatMap((page, index) => turned.rotations[index] === page.rotate ? []
        : [{ num: page.num, gen: page.gen, body: encoder.encode(turnedDictionary(page, turned.rotations[index])) }]);
    const board = encoder.encode(turned.board), packed = await deflate(board);
    const stream = (name: typeof NAMES[number]) => b.streams.get(name)!;
    objects.push({ ...stream('original.pdf'), body: streamBody(`<< /Type /EmbeddedFile /Length ${turned.pristine.length} /Params << /Size ${turned.pristine.length} >> >>`, turned.pristine) });
    objects.push({ ...stream('board.json'), body: streamBody(`<< /Type /EmbeddedFile /Filter /FlateDecode /Length ${packed.length} /DL ${board.length} /Params << /Size ${board.length} >> >>`, packed) });
    // Last, so its placeholder is the file's last mark (utils/pdfWriteMark.ts), as PDFium's writer leaves it.
    objects.push({ ...stream(WRITE_MARK_ATTACHMENT), body: streamBody(`<< /Type /EmbeddedFile /Length 1 /Params << /Size 1 /VaultWriteMark (${pdfWriteMarkV2Placeholder(turned.writeId)}) >> >>`, new Uint8Array([0])) });
    const appendix = appendObjects(reader, b.base, readStartXref(b.prefix), INK_ROTATION_MARK, objects);
    const output = new Uint8Array(b.base + appendix.length);
    output.set(b.prefix); output.set(appendix, b.base);
    await sealPdfWriteMark(output);
    if ((await checkPdfWriteMarkForBoard(output, turned.writeId)).kind !== 'verified') throw new PdfEngineError('FileError', 'PDF write identity could not be verified');
    return output.slice(b.base);
}

export async function planInkRotation(runtime: PdfiumRuntime, bytes: Uint8Array, turns: RotationTurns, context: WorkerContext): Promise<Rotate> {
    const slice = () => context.slice();
    try {
        const b = await basis(bytes, slice), count = b.tree.length;
        const extra = new Int32Array(count);
        for (const [index, amount] of turns.pages) {
            if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError('The PDF page to rotate no longer exists');
            extra[index] += amount;
        }
        const rotations = b.current.map((angle, i) => asQuarter(angle + 90 * (turns.all + extra[i])));
        const before = b.tree.map(page => page.rotate);
        if (rotations.every((angle, i) => angle === before[i])) {
            if (b.base === bytes.length) return { kind: 'unchanged' };
            return { kind: 'update', appendix: new ArrayBuffer(0), base: b.base, pageCount: count, before, rotations };
        }
        const turned = await turnFromBasis(runtime, b, rotations, engineOf(runtime), newPdfWriteId(), slice);
        const appendix = (await section(b, turned)).buffer as ArrayBuffer;
        context.transfer(appendix);
        return { kind: 'update', appendix, base: b.base, pageCount: count, before, rotations };
    } catch (error) {
        if (error instanceof Refused) return { kind: 'refused', cause: error.cause };
        if (error instanceof BoardTurnRefused) return { kind: 'refused', cause: error.reason === 'unknown-content' ? 'newer-annotations' : 'missing-attachment' };
        if (error instanceof InexactTurn || error instanceof PdfSyntaxError) return { kind: 'refused', cause: 'unsupported-format' };
        throw error;
    }
}

export async function verifyInkRotation(runtime: PdfiumRuntime, input: Uint8Array, output: Uint8Array, base: number,
    rotations: readonly number[], context: WorkerContext): Promise<void> {
    const slice = () => context.slice();
    if (!Number.isSafeInteger(base) || base <= 0 || base > input.length) throw fail('the prefix length is invalid');
    const own = await ownInkSection(input);
    if ((own ? own.base : input.length) !== base) throw fail('the replaced section was not this writer’s');
    const b = await basis(input, slice).catch(error => { throw error instanceof Refused ? fail('the source is not an annotated PDF of this app') : error; });
    const streams = new Set([...b.streams.values()].map(entry => entry.num));
    await verifyPageTurn(runtime, input, output, base, rotations, context, {
        async read(bytes) { const section = await ownInkSection(bytes); return section && { base: section.base, objects: section.objects }; },
        extra: streams,
    });
    if (output.length === base) return;
    const inspector = new PdfInkInspector();
    try {
        const inspection = await inspector.inspect(new Blob([output as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), slice);
        if (inspection.kind !== 'native' || inspection.writeId === b.writeId) throw fail('the result does not open as annotated');
        const pristine = new Uint8Array(await inspection.pristine.arrayBuffer());
        const expected = await turnFromBasis(runtime, b, [...rotations], engineOf(runtime), inspection.writeId, slice);
        if (hash(pristine) !== hash(expected.pristine) || inspection.pristineFingerprint !== hash(expected.pristine)) throw fail('the embedded original is not the turned original');
        await verifyPageTurn(runtime, b.pristine, pristine, expected.pristineBase, rotations, context, PAGE_TURN);
        if (await inspection.board.text() !== expected.board) throw fail('the board is not the turned board');
        const turned = rotations.flatMap((angle, i) => angle !== b.tree[i].rotate ? [i] : []);
        const sample = turned.filter((_, k) => k % Math.max(1, Math.ceil(turned.length / 24)) === 0);
        const visible = turnedGeometries(runtime, output, sample), inner = turnedGeometries(runtime, pristine, sample);
        for (const index of sample) {
            const a = visible.get(index)!, c = inner.get(index)!;
            if (a.width !== c.width || a.height !== c.height || a.rotate !== c.rotate || a.toUserSpace.some((value, i) => value !== c.toUserSpace[i])) {
                throw fail(`page ${index + 1} reads differently from its original`);
            }
        }
        const doc = await PDFDocument.load(output, { parseSpeed: Infinity, updateMetadata: false, throwOnInvalidObject: true });
        if (doc.getPageCount() !== rotations.length) throw fail('the page count changed');
    } finally { inspector.dispose(); }
}

