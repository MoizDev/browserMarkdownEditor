import { asQuarter } from '../../utils/pdfRotation';
import {
    PdfObjectReader, PdfSyntaxError, asInt, dictGet, keywordAt, parseObjectHeader, parseValue, readStartXref, readXrefSection,
    sameValue, serializeValue, skipSpace, streamDataStart,
} from './rotationReader';
import type { PdfDictValue, PdfValue } from './rotationReader';

export const ROTATION_MARK = '%local-vault-pdf/v1;rotation;base=';
const MAX_PAGES = 100_000, MAX_NODES = 250_000, MAX_DEPTH = 64;

export interface RotationTurns { readonly all: number; readonly pages: ReadonlyArray<readonly [number, number]> }

export interface PdfRotationPage { readonly num: number; readonly gen: number; readonly dict: PdfDictValue; readonly rotate: number }

export interface OwnRotationSection {
    readonly base: number;
    readonly kind: 'table' | 'stream';
    readonly objects: ReadonlyMap<number, { gen: number; dict: PdfDictValue; rotate: number; offset: number }>;
}

export interface RotationPlan {
    readonly base: number;
    readonly appendix: Uint8Array;
    readonly pageCount: number;
    readonly before: number[];
    readonly rotations: number[];
    readonly replaced: boolean;
}

const latin1 = (bytes: Uint8Array, from: number, to: number) => {
    let text = '';
    for (let i = from; i < to; i++) text += String.fromCharCode(bytes[i]);
    return text;
};

async function rotateValue(reader: PdfObjectReader, value: PdfValue | undefined): Promise<number | undefined> {
    const resolved = await reader.resolve(value);
    if (resolved === undefined || resolved.kind === 'null') return undefined;
    if (resolved.kind !== 'number' || !Number.isFinite(resolved.value) || resolved.value % 90 !== 0) {
        throw new PdfSyntaxError('This PDF has an unsupported page rotation');
    }
    return asQuarter(resolved.value);
}

export async function readPageTree(reader: PdfObjectReader, yieldNow?: () => Promise<void>): Promise<PdfRotationPage[]> {
    const root = await reader.resolve(dictGet(reader.last.trailer, 'Root'));
    if (root?.kind !== 'dict') throw new PdfSyntaxError('PDF catalog is missing');
    const top = dictGet(root, 'Pages');
    if (top?.kind !== 'ref') throw new PdfSyntaxError('PDF page tree is not an indirect object');
    const pages: PdfRotationPage[] = [], seen = new Set<number>();
    const stack: Array<{ num: number; inherited: number | undefined; depth: number }> = [{ num: top.num, inherited: undefined, depth: 0 }];
    while (stack.length) {
        const { num, inherited, depth } = stack.pop()!;
        if (seen.has(num) || seen.size >= MAX_NODES || depth > MAX_DEPTH) throw new PdfSyntaxError('PDF page tree is ambiguous');
        seen.add(num);
        if (yieldNow && seen.size % 512 === 0) await yieldNow();
        const node = await reader.object(num);
        if (node.kind !== 'dict') throw new PdfSyntaxError('PDF page tree node is not a dictionary');
        const type = dictGet(node, 'Type'), kids = await reader.resolve(dictGet(node, 'Kids'));
        const own = await rotateValue(reader, dictGet(node, 'Rotate'));
        const isTree = type?.kind === 'name' ? type.value === 'Pages' : kids !== undefined;
        if (isTree) {
            if (kids?.kind !== 'array') throw new PdfSyntaxError('PDF page tree node has no kids');
            for (let i = kids.items.length - 1; i >= 0; i--) {
                const kid = kids.items[i];
                if (kid.kind !== 'ref') throw new PdfSyntaxError('A PDF page is not an indirect object');
                stack.push({ num: kid.num, inherited: own ?? inherited, depth: depth + 1 });
            }
        } else {
            if (type?.kind === 'name' && type.value !== 'Page') throw new PdfSyntaxError('PDF page tree holds a non-page');
            const gen = reader.generation(num);
            if (gen === undefined) throw new PdfSyntaxError('PDF page object is missing');
            pages.push({ num, gen, dict: node, rotate: own ?? inherited ?? 0 });
            if (pages.length > MAX_PAGES) throw new PdfSyntaxError('PDF has too many pages');
        }
    }
    if (!pages.length) throw new PdfSyntaxError('This PDF has no pages to rotate');
    return pages;
}

export interface AppendedObject {
    readonly gen: number;
    readonly dict: PdfDictValue;
    readonly offset: number;
    readonly stream?: { readonly start: number; readonly length: number };
}

export async function readAppendedSection(bytes: Uint8Array, mark: string):
    Promise<{ base: number; kind: 'table' | 'stream'; objects: Map<number, AppendedObject> } | null> {
    let xref: number;
    try { xref = readStartXref(bytes); } catch { return null; }
    const lineEnd = xref - 1;
    if (bytes[lineEnd] !== 10) return null;
    let lineStart = lineEnd;
    while (lineStart > 0 && bytes[lineStart - 1] !== 10 && lineEnd - lineStart < 80) lineStart--;
    const line = latin1(bytes, lineStart, lineEnd);
    if (!line.startsWith(mark)) return null;
    const baseText = line.slice(mark.length);
    if (!/^\d{1,10}$/.test(baseText)) return null;
    const base = Number(baseText), opening = `\n${mark}${base}\n`;
    if (base <= 0 || base + opening.length > lineStart || latin1(bytes, base, base + opening.length) !== opening) return null;
    try {
        const prefixXref = readStartXref(bytes, base);
        const objects = new Map<number, AppendedObject>();
        let at = base + opening.length;
        while (skipSpace(bytes, at) < xref) {
            const offset = skipSpace(bytes, at), header = parseObjectHeader(bytes, offset), value = parseValue(bytes, header.end);
            if (value.value.kind !== 'dict' || objects.has(header.num)) return null;
            let end = keywordAt(bytes, value.end, 'endobj'), stream: AppendedObject['stream'];
            if (end < 0) {
                const start = streamDataStart(bytes, value.end), length = asInt(dictGet(value.value, 'Length'));
                if (start < 0 || length === undefined || length < 0 || start + length > lineStart) return null;
                const after = keywordAt(bytes, start + length, 'endstream');
                end = after < 0 ? -1 : keywordAt(bytes, after, 'endobj');
                if (end < 0) return null;
                stream = { start, length };
            }
            objects.set(header.num, { gen: header.gen, dict: value.value, offset, ...(stream ? { stream } : {}) });
            at = end;
        }
        if (skipSpace(bytes, at) !== xref || !objects.size) return null;
        const section = await readXrefSection(bytes, xref);
        if (section.hybrid || asInt(dictGet(section.trailer, 'Prev')) !== prefixXref) return null;
        const listed = new Map(section.entries);
        if (section.kind === 'stream') {
            const self = parseObjectHeader(bytes, xref);
            const entry = listed.get(self.num);
            if (entry?.type !== 1 || entry.offset !== xref) return null;
            listed.delete(self.num);
        }
        if (listed.size !== objects.size) return null;
        for (const [num, object] of objects) {
            const entry = listed.get(num);
            if (entry?.type !== 1 || entry.offset !== object.offset || entry.gen !== object.gen) return null;
        }
        const tail = latin1(bytes, section.end, bytes.length);
        if (!new RegExp(`^\\s*startxref\\s+${xref}\\s+%%EOF\\s*$`).test(tail)) return null;
        return { base, kind: section.kind, objects };
    } catch { return null; }
}

export async function readOwnRotationSection(bytes: Uint8Array): Promise<OwnRotationSection | null> {
    const section = await readAppendedSection(bytes, ROTATION_MARK);
    if (!section) return null;
    const objects = new Map<number, { gen: number; dict: PdfDictValue; rotate: number; offset: number }>();
    for (const [num, object] of section.objects) {
        const type = dictGet(object.dict, 'Type'), rotate = asInt(dictGet(object.dict, 'Rotate'));
        if (object.stream || type?.kind !== 'name' || type.value !== 'Page' || rotate === undefined || rotate % 90 !== 0 || rotate < 0 || rotate >= 360) return null;
        objects.set(num, { gen: object.gen, dict: object.dict, rotate, offset: object.offset });
    }
    return { base: section.base, kind: section.kind, objects };
}

export function turnedDictionary(page: PdfRotationPage, rotate: number): string {
    const entries = new Map(page.dict.entries);
    entries.delete('Rotate');
    entries.set('Rotate', { kind: 'number', value: rotate, raw: String(rotate) });
    return serializeValue({ kind: 'dict', entries });
}

function trailerValue(trailer: PdfDictValue, key: string): string | undefined {
    const value = dictGet(trailer, key);
    return value === undefined ? undefined : serializeValue(value);
}

const encoder = new TextEncoder();

export interface ObjectBody { readonly num: number; readonly gen: number; readonly body: Uint8Array }

export function appendObjects(prefix: PdfObjectReader, base: number, prevXref: number, mark: string, objects: readonly ObjectBody[]): Uint8Array {
    const trailer = prefix.last.trailer, size = asInt(dictGet(trailer, 'Size'));
    if (size === undefined || size <= 0) throw new PdfSyntaxError('PDF trailer has no /Size');
    const parts: Uint8Array[] = [], offsets: Array<[number, number, number]> = [];
    let length = 0;
    const push = (part: string | Uint8Array) => { const bytes = typeof part === 'string' ? encoder.encode(part) : part; parts.push(bytes); length += bytes.length; };
    const marker = `${mark}${base}\n`;
    push(`\n${marker}`);
    for (const object of objects) {
        if (object.num >= size) throw new PdfSyntaxError('PDF object lies beyond the trailer /Size');
        offsets.push([object.num, base + length, object.gen]);
        push(`${object.num} ${object.gen} obj\n`); push(object.body); push('\nendobj\n');
    }
    push(marker);
    const xref = base + length;
    const common = [`/Root ${trailerValue(trailer, 'Root')}`, ...(['Info', 'ID'] as const)
        .flatMap(key => { const value = trailerValue(trailer, key); return value === undefined ? [] : [`/${key} ${value}`]; }), `/Prev ${prevXref}`];
    if (trailerValue(trailer, 'Root') === undefined) throw new PdfSyntaxError('PDF trailer has no /Root');
    const rows = [...offsets].sort((a, b) => a[0] - b[0]);
    const groups: Array<Array<[number, number, number]>> = [];
    for (const row of rows) {
        const last = groups.at(-1);
        if (last && last.at(-1)![0] + 1 === row[0]) last.push(row); else groups.push([row]);
    }
    const join = () => {
        const out = new Uint8Array(length);
        let at = 0;
        for (const part of parts) { out.set(part, at); at += part.length; }
        return out;
    };
    if (prefix.last.kind === 'table') {
        let table = 'xref\n';
        for (const group of groups) {
            table += `${group[0][0]} ${group.length}\n`;
            for (const [, offset, gen] of group) table += `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`;
        }
        push(`${table}trailer\n<< /Size ${size} ${common.join(' ')} >>\nstartxref\n${xref}\n%%EOF\n`);
        return join();
    }
    const self = size;
    const all = [...rows, [self, xref, 0] as [number, number, number]];
    const index: number[] = [];
    for (const group of [...groups, [[self, xref, 0] as [number, number, number]]]) index.push(group[0][0], group.length);
    const data = new Uint8Array(all.length * 7);
    all.forEach(([, offset, gen], i) => {
        if (offset > 0xffffffff || gen > 0xffff) throw new PdfSyntaxError('PDF offset exceeds the cross-reference width');
        const row = i * 7;
        data[row] = 1;
        data[row + 1] = offset >>> 24 & 0xff; data[row + 2] = offset >>> 16 & 0xff; data[row + 3] = offset >>> 8 & 0xff; data[row + 4] = offset & 0xff;
        data[row + 5] = gen >>> 8 & 0xff; data[row + 6] = gen & 0xff;
    });
    push(`${self} 0 obj\n<< /Type /XRef /Size ${size + 1} /W [1 4 2] /Index [${index.join(' ')}] ${common.join(' ')} /Length ${data.length} >>\nstream\n`);
    push(data);
    push(`\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`);
    return join();
}

function appendSection(prefix: PdfObjectReader, base: number, prevXref: number, tree: readonly PdfRotationPage[],
    changes: ReadonlyArray<readonly [number, number]>): Uint8Array {
    return appendObjects(prefix, base, prevXref, ROTATION_MARK, changes.map(([index, rotate]) => {
        const page = tree[index];
        return { num: page.num, gen: page.gen, body: encoder.encode(turnedDictionary(page, rotate)) };
    }));
}

export async function planRotation(bytes: Uint8Array, turns: RotationTurns, yieldNow?: () => Promise<void>): Promise<RotationPlan | null> {
    const full = await PdfObjectReader.open(bytes);
    if (dictGet(full.last.trailer, 'Encrypt') !== undefined) throw new PdfSyntaxError('Encrypted PDF cannot be rotated');
    let own = await readOwnRotationSection(bytes);
    let prefix = full, tree: PdfRotationPage[] | undefined;
    if (own) {
        // Ours only if every object it redefines is a page of the prefix, unchanged but for /Rotate.
        const candidate = await PdfObjectReader.open(bytes, own.base);
        const pages = await readPageTree(candidate, yieldNow);
        const byNum = new Map(pages.map(page => [page.num, page]));
        const matches = [...own.objects].every(([num, object]) => {
            const page = byNum.get(num);
            if (!page || page.gen !== object.gen) return false;
            const a = new Map(page.dict.entries), b = new Map(object.dict.entries);
            a.delete('Rotate'); b.delete('Rotate');
            return sameValue({ kind: 'dict', entries: a }, { kind: 'dict', entries: b });
        });
        if (matches) { prefix = candidate; tree = pages; } else own = null;
    }
    tree ??= await readPageTree(full, yieldNow);
    const count = tree.length;
    const current = tree.map(page => own?.objects.get(page.num)?.rotate ?? page.rotate);
    const extra = new Int32Array(count);
    for (const [index, amount] of turns.pages) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError('The PDF page to rotate no longer exists');
        extra[index] += amount;
    }
    if (!Number.isSafeInteger(turns.all)) throw new RangeError('Invalid PDF rotation');
    const rotations: number[] = current.map((angle, i) => asQuarter(angle + 90 * (turns.all + extra[i])));
    const before = tree.map(page => page.rotate);
    const changes = rotations.flatMap((angle, i) => angle !== before[i] ? [[i, angle] as const] : []);
    if (!own && !changes.length) return null;
    const base = own ? own.base : bytes.length;
    if (own && !changes.length) return { base, appendix: new Uint8Array(0), pageCount: count, before, rotations, replaced: true };
    const appendix = appendSection(prefix, base, readStartXref(bytes, base), tree, changes);
    return { base, appendix, pageCount: count, before, rotations, replaced: !!own };
}
