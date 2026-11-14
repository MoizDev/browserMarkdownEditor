import { selectionRange } from './selection';
import type { PdfSelection } from './selection';

export const MAX_COPY_UTF16_UNITS = 16 * 1024 * 1024 / 2;
export const COPY_TOO_LARGE = 'Selection too large to copy (over 16 MiB of text); use Read extracted text.';

/** Clipboard-only compatibility folding. Canonical text and find offsets are
 * never changed; untouched mathematical and compatibility characters stay so. */
export function normalizeForClipboard(text: string): string {
    let out = '';
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp === 0 || cp === 0xfffe || cp === 0xffff) continue;
        const space = cp === 0xa0 || cp >= 0x2000 && cp <= 0x200a || cp === 0x202f || cp === 0x205f || cp === 0x3000;
        if (space) { out += ' '; continue; }
        const compatibility = cp >= 0xfb00 && cp <= 0xfb4f || cp >= 0xfb50 && cp <= 0xfdff ||
            cp >= 0xfe70 && cp <= 0xfefc || cp === 0xb5 || cp === 0x37e || cp === 0x2126;
        out += compatibility ? ch.normalize('NFKC') : ch;
    }
    return out;
}
export type CopyResult =
    | { kind: 'ready'; text: string }
    | { kind: 'missing'; pages: number[] }
    | { kind: 'too-large'; message: string };

/** Pure synchronous gather; the host requests missing pages, then calls again. */
export function copySelection(selection: PdfSelection, pageCount: number, pages: ReadonlyMap<number, string>): CopyResult {
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) return { kind: 'missing', pages: [] };
    if (!pageCount) return { kind: 'ready', text: '' };
    const range = selectionRange(selection);
    const first = selection.wholeDocument ? 0 : Math.max(0, Math.min(pageCount - 1, range.start.page));
    const last = selection.wholeDocument ? pageCount - 1 : Math.max(first, Math.min(pageCount - 1, range.end.page));
    const missing: number[] = [], chunks: string[] = [];
    let units = 0;
    for (let page = first; page <= last; page++) {
        const text = pages.get(page);
        if (text === undefined) { missing.push(page); continue; }
        const from = !selection.wholeDocument && page === first ? Math.max(0, Math.min(text.length, range.start.offset)) : 0;
        const to = !selection.wholeDocument && page === last ? Math.max(from, Math.min(text.length, range.end.offset)) : text.length;
        units += to - from + (page > first ? 1 : 0);
        if (units > MAX_COPY_UTF16_UNITS) return { kind: 'too-large', message: COPY_TOO_LARGE };
        chunks.push(text.slice(from, to));
    }
    if (missing.length) return { kind: 'missing', pages: missing };
    const text = normalizeForClipboard(chunks.join('\n'));
    return text.length > MAX_COPY_UTF16_UNITS ? { kind: 'too-large', message: COPY_TOO_LARGE } : { kind: 'ready', text };
}
/** Cached-only agent report; an uncached gap is explicit rather than silently
 * pretending that the following page was adjacent. */
export function cachedSelectionText(selection: PdfSelection, pageCount: number, pages: ReadonlyMap<number, string>, limit = 20_000): { text: string; incomplete: boolean } {
    if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return { text: '', incomplete: false };
    const range = selectionRange(selection);
    const first = selection.wholeDocument ? 0 : Math.max(0, Math.min(pageCount - 1, range.start.page));
    const last = selection.wholeDocument ? pageCount - 1 : Math.max(first, Math.min(pageCount - 1, range.end.page));
    const parts: string[] = [];
    let units = 0, incomplete = false;
    const cap = Math.max(0, Math.trunc(limit));
    for (let page = first; page <= last; page++) {
        const value = pages.get(page);
        if (value === undefined) { incomplete = true; continue; }
        const from = !selection.wholeDocument && page === first ? Math.max(0, Math.min(value.length, range.start.offset)) : 0;
        const to = !selection.wholeDocument && page === last ? Math.max(from, Math.min(value.length, range.end.offset)) : value.length;
        const part = normalizeForClipboard(value.slice(from, to));
        const sep = parts.length ? '\n' : '';
        const available = Math.max(0, cap - units - sep.length);
        parts.push(sep + part.slice(0, available));
        units += sep.length + Math.min(part.length, available);
        if (part.length > available || units >= cap && page < last) { incomplete = true; break; }
    }
    return { text: parts.join('') + (incomplete && units >= cap ? '…' : ''), incomplete };
}
