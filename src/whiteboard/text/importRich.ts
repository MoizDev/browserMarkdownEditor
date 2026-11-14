import { parseJson } from '../format/jsonRead';
import type { RawJson } from '../model/json';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { normalizeRichText, type Block, type Marks, type RichText, type Run } from './richText';
import type { RichImportResult } from './rich';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null;
}
function children(value: RecordValue): readonly unknown[] { return Array.isArray(value.content) ? value.content : []; }
function raw(value: unknown): RawJson {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > MAX_TEXT_LENGTH * 4) throw new RangeError('Unsupported rich data exceeds preservation limit');
    return parseJson(encoded).raw();
}
function validLink(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 || (code >= 127 && code <= 159)) return false;
    }
    try {
        const url = new URL(value);
        return !url.username && !url.password && (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:');
    } catch { return false; }
}
function repairSurrogates(text: string): { text: string; count: number } {
    let out = '', count = 0, last = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { i++; continue; }
        if (c >= 0xd800 && c <= 0xdfff) { out += text.slice(last, i) + '\ufffd'; last = i + 1; count++; }
    }
    return { text: count ? out + text.slice(last) : text, count };
}

/** Data-only ProseMirror mapping; unrepresentable input must keep its legacy source read-only. */
export function convertLegacyRichText(input: unknown): RichImportResult {
    const repairs: string[] = [], unrepresentable: string[] = [], blocks: Block[] = [];
    let visited = 0, total = 0, replaced = 0;
    const fail = (message: string): never => { throw new Error(message); };
    const account = (depth: number) => {
        if (++visited > 200_000 || depth > 64) fail('Rich text structure exceeds safe limits');
    };
    const clean = (text: string): string => {
        const fixed = repairSurrogates(text); replaced += fixed.count;
        total += fixed.text.length;
        if (total > MAX_TEXT_LENGTH) fail('Rich text exceeds 1000000 UTF-16 units');
        return fixed.text.replace(/\r\n?/g, '\n');
    };
    const push = (block: Block) => {
        if (blocks.length >= MAX_TEXT_BLOCKS) fail('Rich text exceeds 100000 blocks');
        if (blocks.length && ++total > MAX_TEXT_LENGTH) fail('Rich text exceeds 1000000 UTF-16 units');
        blocks.push(block);
    };
    const marks = (value: unknown): Marks => {
        const result: { b?: true; i?: true; u?: true; s?: true; code?: true; hl?: true; link?: string; x?: RawJson } = {};
        const extra: unknown[] = [];
        if (value === undefined) return result;
        if (!Array.isArray(value)) { extra.push(value); }
        else for (const item of value) {
            const mark = record(item), attrs = mark && record(mark.attrs);
            switch (mark?.type) {
                case 'bold': result.b = true; break;
                case 'italic': result.i = true; break;
                case 'underline': result.u = true; break;
                case 'strike': result.s = true; break;
                case 'code': result.code = true; break;
                case 'highlight': result.hl = true; break;
                case 'link':
                    if (validLink(attrs?.href)) result.link = attrs.href;
                    else repairs.push('Dropped an unsafe or invalid link');
                    break;
                default: extra.push(item);
            }
        }
        if (extra.length) { result.x = raw(extra); repairs.push('Preserved unsupported inline marks'); }
        return result;
    };
    const collect = (node: unknown, depth: number): string => {
        account(depth);
        const data = record(node);
        if (!data) return typeof node === 'string' ? node : '';
        if (data.type === 'text') return typeof data.text === 'string' ? data.text : '';
        if (data.type === 'hardBreak') return '\u2028';
        return children(data).map(child => collect(child, depth + 1)).join('');
    };
    const inline = (source: readonly unknown[], kind: Block['kind'], level: number, dir: Block['dir'], start: number | undefined, depth: number) => {
        let runs: Run[] = [];
        let first = true;
        const flush = () => {
            push({ kind, level, dir, ...(first && start !== undefined ? { start } : {}), runs: runs.length ? runs : [{ text: '', marks: {} }] });
            runs = []; first = false;
        };
        const append = (value: string, styling: Marks) => {
            const parts = clean(value).split('\n');
            for (let i = 0; i < parts.length; i++) {
                if (parts[i] || parts.length === 1) runs.push({ text: parts[i], marks: styling });
                if (i < parts.length - 1) flush();
            }
        };
        for (const item of source) {
            account(depth);
            const node = record(item);
            if (node?.type === 'text' && typeof node.text === 'string') append(node.text, marks(node.marks));
            else if (node?.type === 'hardBreak') append('\u2028', {});
            else {
                append(collect(item, depth + 1), { x: raw(item) });
                repairs.push('Preserved an unsupported inline node');
            }
        }
        flush();
    };
    const direction = (node: RecordValue): Block['dir'] => {
        const dir = record(node.attrs)?.dir;
        return dir === 'ltr' || dir === 'rtl' ? dir : 'auto';
    };
    const visit = (value: unknown, depth: number, list: 'ul' | 'ol' | null = null, level = 0, start?: number): void => {
        account(depth);
        const node = record(value);
        if (!node) { if (typeof value === 'string') inline([{ type: 'text', text: value }], 'p', 0, 'auto', undefined, depth + 1); else fail('Invalid rich text node'); return; }
        switch (node.type) {
            case 'doc': for (const child of children(node)) visit(child, depth + 1); return;
            case 'paragraph': inline(children(node), list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1); return;
            case 'heading': {
                const n = record(node.attrs)?.level;
                if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 6) { repairs.push('Invalid heading level became a paragraph'); inline(children(node), 'p', 0, direction(node), undefined, depth + 1); }
                else inline(children(node), `h${n}` as Block['kind'], 0, direction(node), undefined, depth + 1);
                return;
            }
            case 'bulletList': case 'orderedList': {
                const kind = node.type === 'bulletList' ? 'ul' : 'ol';
                const nextLevel = list ? level + 1 : level;
                if (nextLevel > 7) fail('List nesting exceeds eight levels');
                const initial = record(node.attrs)?.start;
                let first = true;
                for (const child of children(node)) {
                    const initialStart = kind === 'ol' && first && typeof initial === 'number' && Number.isFinite(initial) ? initial : undefined;
                    visit(child, depth + 1, kind, nextLevel, initialStart); first = false;
                }
                return;
            }
            case 'listItem': {
                let first = true;
                for (const child of children(node)) { visit(child, depth + 1, list, level, first ? start : undefined); first = false; }
                if (first) inline([], list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1);
                return;
            }
            case 'text': case 'hardBreak': inline([node], list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1); return;
            default:
                inline([{ type: 'text', text: collect(node, depth + 1), marks: [{ type: 'unsupported', node }] }], 'p', 0, direction(node), undefined, depth + 1);
                repairs.push('Preserved an unsupported block node');
        }
    };
    try {
        if (typeof input === 'string') inline([{ type: 'text', text: input }], 'p', 0, 'auto', undefined, 0);
        else if (input === null || input === undefined) inline([], 'p', 0, 'auto', undefined, 0);
        else visit(input, 0);
        if (!blocks.length) inline([], 'p', 0, 'auto', undefined, 0);
        if (replaced) repairs.push(`Replaced ${replaced} lone surrogate${replaced === 1 ? '' : 's'}`);
        return { text: normalizeRichText({ blocks }), repairs, unrepresentable };
    } catch (error) {
        unrepresentable.push(error instanceof Error ? error.message : 'Rich text could not be represented');
        const text: RichText = { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] };
        return { text, repairs, unrepresentable };
    }
}
