// Turning PDF pages as an INCREMENTAL UPDATE: the file's bytes stay exactly as
// they were, and a short section appended after them redefines only the turned
// page dictionaries (each a copy of the original with a new /Rotate) and points
// a new cross-reference section back at the old one through /Prev.
//
// Why: the old route re-saved the whole document through PDFium and then tried
// to prove that the re-save changed nothing else, decoding and hashing every
// stream to do it. That took ~9s on a 62-page scan and was refused outright for 7
// of 9 real PDFs (the inventory changed across the re-save, or hit its work cap).
// Appended, the original is a byte-exact prefix of the result, so "nothing else
// changed" is a prefix comparison plus a parse of the few objects after it.
//
// GROWTH IS BOUNDED. A section this writer appended is marked (MARK, twice: where
// it starts and right before its xref, so finding it costs nothing). When the
// file still ends with one, the next turn REPLACES it instead of stacking another:
// it is rebuilt over the untouched prefix with every page's final angle, so four
// presses back to the start return the file to its original bytes exactly. A
// section anyone else appended afterwards is left alone and stacked upon.

import { asQuarter } from '../../utils/pdfRotation';
import {
    PdfObjectReader, PdfSyntaxError, asInt, dictGet, keywordAt, parseObjectHeader, parseValue, readStartXref, readXrefSection,
    sameValue, serializeValue, skipSpace,
} from './rotationReader';
import type { PdfDictValue, PdfValue } from './rotationReader';

export const ROTATION_MARK = '%local-vault-pdf/v1;rotation;base=';
const MAX_PAGES = 100_000, MAX_NODES = 250_000, MAX_DEPTH = 64;

/** Quarter turns: `all` for every page, plus per-page extras (Alt-turns). */
export interface RotationTurns { readonly all: number; readonly pages: ReadonlyArray<readonly [number, number]> }

export interface PdfRotationPage { readonly num: number; readonly gen: number; readonly dict: PdfDictValue; readonly rotate: number }

export interface OwnRotationSection {
    /** Length of the untouched prefix this section was appended to. */
    readonly base: number;
    readonly kind: 'table' | 'stream';
    /** Page objects the section redefines, with their /Rotate. */
    readonly objects: ReadonlyMap<number, { gen: number; dict: PdfDictValue; rotate: number; offset: number }>;
}

export interface RotationPlan {
    readonly base: number;
    readonly appendix: Uint8Array;
    readonly pageCount: number;
    /** The prefix's angles and the result's, per page. */
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

/** Every page leaf in document order, with its effective (inherited, indirect-resolved) /Rotate. */
export async function readPageTree(reader: PdfObjectReader, yieldNow?: () => Promise<void>): Promise<PdfRotationPage[]> {
    const root = await reader.resolve(dictGet(reader.last.trailer, 'Root'));
    if (root?.kind !== 'dict') throw new PdfSyntaxError('PDF catalog is missing');
    const top = dictGet(root, 'Pages');
    if (top?.kind !== 'ref') throw new PdfSyntaxError('PDF page tree is not an indirect object');
    const pages: PdfRotationPage[] = [], seen = new Set<number>();
    // Depth-first, children in order: a stack of pending kids, reversed on push.
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

/** The section this writer appended last, if the file still ends with one; null when it does not.
 * Strict: anything but exactly the shape this writer produces is not "ours" and is never replaced. */
export async function readOwnRotationSection(bytes: Uint8Array): Promise<OwnRotationSection | null> {
    let xref: number;
    try { xref = readStartXref(bytes); } catch { return null; }
    // The marker is the line right before the final xref section.
    const lineEnd = xref - 1;
    if (bytes[lineEnd] !== 10) return null;
    let lineStart = lineEnd;
    while (lineStart > 0 && bytes[lineStart - 1] !== 10 && lineEnd - lineStart < 64) lineStart--;
    const line = latin1(bytes, lineStart, lineEnd);
    if (!line.startsWith(ROTATION_MARK)) return null;
    const baseText = line.slice(ROTATION_MARK.length);
    if (!/^\d{1,10}$/.test(baseText)) return null;
    const base = Number(baseText), opening = `\n${ROTATION_MARK}${base}\n`;
    if (base <= 0 || base + opening.length > lineStart || latin1(bytes, base, base + opening.length) !== opening) return null;
    try {
        const prefixXref = readStartXref(bytes, base);
        const objects = new Map<number, { gen: number; dict: PdfDictValue; rotate: number; offset: number }>();
        let at = base + opening.length;
        while (skipSpace(bytes, at) < xref) {
            const offset = skipSpace(bytes, at), header = parseObjectHeader(bytes, offset), value = parseValue(bytes, header.end);
            const end = keywordAt(bytes, value.end, 'endobj');
            if (end < 0 || value.value.kind !== 'dict' || objects.has(header.num)) return null;
            const type = dictGet(value.value, 'Type'), rotate = asInt(dictGet(value.value, 'Rotate'));
            if (type?.kind !== 'name' || type.value !== 'Page' || rotate === undefined || rotate % 90 !== 0 || rotate < 0 || rotate >= 360) return null;
            objects.set(header.num, { gen: header.gen, dict: value.value, rotate, offset });
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

/** The page dictionary as written, with /Rotate set (and only that changed). */
function turnedDictionary(page: PdfRotationPage, rotate: number): string {
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

/** Builds the appended section for `pages` (index → final angle) over the prefix `bytes[0, base)`. */
function appendSection(prefix: PdfObjectReader, base: number, prevXref: number, tree: readonly PdfRotationPage[],
    changes: ReadonlyArray<readonly [number, number]>): Uint8Array {
    const trailer = prefix.last.trailer, size = asInt(dictGet(trailer, 'Size'));
    if (size === undefined || size <= 0) throw new PdfSyntaxError('PDF trailer has no /Size');
    const parts: string[] = [], offsets: Array<[number, number, number]> = [];
    let length = 0;
    const push = (text: string) => { parts.push(text); length += text.length; };
    const marker = `${ROTATION_MARK}${base}\n`;
    push(`\n${marker}`);
    for (const [index, rotate] of changes) {
        const page = tree[index];
        if (page.num >= size) throw new PdfSyntaxError('PDF page object lies beyond the trailer /Size');
        offsets.push([page.num, base + length, page.gen]);
        push(`${page.num} ${page.gen} obj\n${turnedDictionary(page, rotate)}\nendobj\n`);
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
    if (prefix.last.kind === 'table') {
        let table = 'xref\n';
        for (const group of groups) {
            table += `${group[0][0]} ${group.length}\n`;
            for (const [, offset, gen] of group) table += `${String(offset).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`;
        }
        push(`${table}trailer\n<< /Size ${size} ${common.join(' ')} >>\nstartxref\n${xref}\n%%EOF\n`);
        return encoder.encode(parts.join(''));
    }
    // A cross-reference stream, matching the file's own last section. Uncompressed:
    // a handful of 7-byte rows is not worth a filter readers must then support.
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
    const head = `${self} 0 obj\n<< /Type /XRef /Size ${size + 1} /W [1 4 2] /Index [${index.join(' ')}] ${common.join(' ')} /Length ${data.length} >>\nstream\n`;
    const tail = `\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`;
    const text = encoder.encode(parts.join('') + head), end = encoder.encode(tail);
    const out = new Uint8Array(text.length + data.length + end.length);
    out.set(text); out.set(data, text.length); out.set(end, text.length + data.length);
    return out;
}

/** Plans the turn over `bytes`. Null means the file already shows these angles: nothing to write. */
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
