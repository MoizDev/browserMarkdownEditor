import { parseJson, type JsonSpan } from '../format/jsonRead';
import type { RawJson } from '../model/json';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { normalizeRichText, type Block, type Marks, type RichText, type Run } from './richText';
import type { RichImportResult } from './rich';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null;
}
function children(value: RecordValue): readonly unknown[] { return Array.isArray(value.content) ? value.content : []; }
function raw(value: unknown, originals?: WeakMap<object, RawJson | JsonSpan>): RawJson {
    if (typeof value === 'object' && value !== null) {
        const original = originals?.get(value);
        if (original !== undefined) {
            const encoded = typeof original === 'string' ? original : original.raw();
            if (encoded.length > MAX_TEXT_LENGTH * 4) throw new RangeError('Unsupported rich data exceeds preservation limit');
            return encoded;
        }
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > MAX_TEXT_LENGTH * 4) throw new RangeError('Unsupported rich data exceeds preservation limit');
    return parseJson(encoded).raw();
}
function validLink(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048 || /\p{Cc}/u.test(value)) return false;
    try {
        const url = new URL(value);
        return !url.username && !url.password && (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:');
    } catch { return false; }
}
function repairCharacters(text: string): { text: string; surrogates: number; controls: number } {
    let out = '', surrogates = 0, controls = 0, last = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { i++; continue; }
        const surrogate = c >= 0xd800 && c <= 0xdfff;
        const control = c < 32 && c !== 9 && c !== 10 && c !== 13;
        if (surrogate || control) {
            out += text.slice(last, i) + '\ufffd'; last = i + 1;
            if (surrogate) surrogates++; else controls++;
        }
    }
    return { text: surrogates || controls ? out + text.slice(last) : text, surrogates, controls };
}

/** Data-only ProseMirror mapping; unrepresentable input must keep its legacy source read-only. */
export function convertLegacyRichText(input: unknown, originals?: WeakMap<object, RawJson | JsonSpan>): RichImportResult {
    const repairs: string[] = [], unrepresentable: string[] = [], blocks: Block[] = [];
    let visited = 0, total = 0, replaced = 0, controls = 0, preservedFields = 0, preservedBytes = 0;
    const fail = (message: string): never => { throw new Error(message); };
    const account = (depth: number) => {
        if (++visited > 200_000 || depth > 64) fail('Rich text structure exceeds safe limits');
    };
    const clean = (text: string): string => {
        const fixed = repairCharacters(text); replaced += fixed.surrogates; controls += fixed.controls;
        const normalized = fixed.text.replace(/\r\n?/g, '\n');
        let separators = 0;
        for (let index = 0; index < normalized.length; index++) if (normalized.charCodeAt(index) === 10) separators++;
        // Each emitted block contributes its separator in push(), not here as well.
        total += normalized.length - separators;
        if (total > MAX_TEXT_LENGTH) fail('Rich text exceeds 1000000 UTF-16 units');
        return normalized;
    };
    const push = (block: Block) => {
        if (blocks.length >= MAX_TEXT_BLOCKS) fail('Rich text exceeds 100000 blocks');
        if (blocks.length && ++total > MAX_TEXT_LENGTH) fail('Rich text exceeds 1000000 UTF-16 units');
        blocks.push(block);
    };
    const accountOpaque = (value: RawJson): RawJson => {
        preservedBytes += value.length;
        if (preservedBytes > MAX_TEXT_LENGTH * 4) fail('Unsupported rich data exceeds preservation limit');
        return value;
    };
    // A known legacy node can also carry fields from a newer schema. Keep those
    // fields as an opaque zero-width mark, without copying its whole subtree.
    const unknownFields = (object: RecordValue, keep: (key: string, value: unknown) => boolean): string | null => {
        const original = originals?.get(object);
        const fields: string[] = [];
        let size = 2;
        const add = (field: string) => {
            size += field.length + (fields.length ? 1 : 0);
            if (size > MAX_TEXT_LENGTH * 4 - preservedBytes) fail('Unsupported rich node fields exceed preservation limit');
            fields.push(field);
        };
        if (original && typeof original !== 'string' && original.kind === 'object') {
            let previous = original.start + 1;
            for (const [key, span] of original.fields()) {
                let start = previous;
                while (start < span.start && /[\s,]/.test(original.source[start])) start++;
                if (keep(key, object[key])) add(original.source.slice(start, span.start) + span.raw());
                previous = span.end;
            }
        } else {
            for (const key of Object.keys(object)) if (keep(key, object[key]))
                add(`${JSON.stringify(key)}:${raw(object[key], originals)}`);
        }
        return fields.length ? `{${fields.join(',')}}` : null;
    };
    const extras = (node: RecordValue, fields: readonly string[], attributes: (key: string, value: unknown) => boolean): RawJson | undefined => {
        const unknown = unknownFields(node, (key, value) => {
            if (key === 'attrs') return value !== undefined && value !== null && !record(value);
            if (key === 'content' && fields.includes(key)) return !Array.isArray(value);
            return !fields.includes(key) && key !== 'attrs';
        });
        const attrs = record(node.attrs);
        const unknownAttrs = attrs && unknownFields(attrs, (key, value) => !attributes(key, value));
        if (!unknown && !unknownAttrs) return undefined;
        const data = `[{"type":"legacy-node-fields","nodeType":${JSON.stringify(node.type ?? null)}${unknown ? `,"fields":${unknown}` : ''}${unknownAttrs ? `,"attrs":${unknownAttrs}` : ''}}]`;
        if (data.length > MAX_TEXT_LENGTH * 4 - preservedBytes) fail('Unsupported rich node fields exceed preservation limit');
        preservedFields++;
        return accountOpaque(parseJson(data).raw());
    };
    const attach = (index: number, data: RawJson | undefined) => {
        if (data === undefined) return;
        const block = blocks[index];
        blocks[index] = { ...block, runs: [{ text: '', marks: { x: data } }, ...block.runs] };
    };
    const directionAttribute = (key: string, value: unknown) => key === 'dir' && (value === 'auto' || value === 'ltr' || value === 'rtl');
    const noAttributes = () => false;
    const marks = (value: unknown): Marks => {
        const result: { b?: true; i?: true; u?: true; s?: true; code?: true; hl?: true; link?: string; x?: RawJson } = {};
        const extra: unknown[] = [];
        if (value === undefined) return result;
        if (!Array.isArray(value)) { extra.push(value); }
        else for (const item of value) {
            const mark = record(item), attrs = mark && record(mark.attrs);
            let known = true, preserve = false;
            switch (mark?.type) {
                case 'bold': result.b = true; break;
                case 'italic': result.i = true; break;
                case 'underline': result.u = true; break;
                case 'strike': result.s = true; break;
                case 'code': result.code = true; break;
                case 'highlight': result.hl = true; break;
                case 'link':
                    if (validLink(attrs?.href)) result.link = attrs.href;
                    else { preserve = true; repairs.push('Dropped an unsafe or invalid link'); }
                    break;
                default: known = false;
            }
            if (known && mark) {
                if (Object.keys(mark).some(key => key !== 'type' && key !== 'attrs')) preserve = true;
                if (mark.attrs !== undefined && mark.attrs !== null && !attrs) preserve = true;
                if (attrs && Object.keys(attrs).some(key => mark.type !== 'link' || key !== 'href')) preserve = true;
            }
            if (!known || preserve) extra.push(item);
        }
        if (extra.length) {
            const values: RawJson[] = [];
            let size = 2;
            for (const item of extra) {
                const encoded = raw(item, originals);
                size += encoded.length + (values.length ? 1 : 0);
                if (size > MAX_TEXT_LENGTH * 4 - preservedBytes) fail('Unsupported rich marks exceed preservation limit');
                values.push(encoded);
            }
            result.x = accountOpaque(parseJson(`[${values.join(',')}]`).raw());
            repairs.push('Preserved unsupported inline marks');
        }
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
            if (parts.length > 1 && styling.x !== undefined) fail('Cannot split an unsupported rich run safely');
            for (let i = 0; i < parts.length; i++) {
                if (parts[i] || parts.length === 1) runs.push({ text: parts[i], marks: styling });
                if (i < parts.length - 1) flush();
            }
        };
        for (const item of source) {
            account(depth);
            const node = record(item);
            if (node?.type === 'text' && typeof node.text === 'string') {
                const data = extras(node, ['type', 'text', 'marks'], noAttributes);
                if (data !== undefined) runs.push({ text: '', marks: { x: data } });
                append(node.text, marks(node.marks));
            } else if (node?.type === 'hardBreak') {
                const data = extras(node, ['type'], noAttributes);
                if (data !== undefined) runs.push({ text: '', marks: { x: data } });
                append('\u2028', {});
            } else {
                append(collect(item, depth + 1), { x: accountOpaque(raw(item, originals)) });
                repairs.push('Preserved an unsupported inline node');
            }
        }
        flush();
    };
    const direction = (node: RecordValue): Block['dir'] => {
        const dir = record(node.attrs)?.dir;
        return dir === 'ltr' || dir === 'rtl' ? dir : 'auto';
    };
    const withFields = (node: RecordValue, fields: readonly string[], attributes: (key: string, value: unknown) => boolean, emit: () => void) => {
        const data = extras(node, fields, attributes), first = blocks.length;
        emit();
        if (data !== undefined && first === blocks.length) inline([], 'p', 0, 'auto', undefined, 0);
        attach(first, data);
    };
    const visit = (value: unknown, depth: number, list: 'ul' | 'ol' | null = null, level = 0, start?: number): void => {
        account(depth);
        const node = record(value);
        if (!node) { if (typeof value === 'string') inline([{ type: 'text', text: value }], 'p', 0, 'auto', undefined, depth + 1); else fail('Invalid rich text node'); return; }
        switch (node.type) {
            case 'doc':
                withFields(node, ['type', 'content'], noAttributes, () => { for (const child of children(node)) visit(child, depth + 1); });
                return;
            case 'paragraph':
                withFields(node, ['type', 'content'], directionAttribute, () => inline(children(node), list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1));
                return;
            case 'heading': {
                const n = record(node.attrs)?.level;
                const valid = typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 6;
                withFields(node, ['type', 'content'], (key, value) => directionAttribute(key, value) || (key === 'level' && valid), () => {
                    if (!valid) { repairs.push('Invalid heading level became a paragraph'); inline(children(node), 'p', 0, direction(node), undefined, depth + 1); }
                    else inline(children(node), `h${n}` as Block['kind'], 0, direction(node), undefined, depth + 1);
                });
                return;
            }
            case 'bulletList': case 'orderedList': {
                const kind = node.type === 'bulletList' ? 'ul' : 'ol';
                const nextLevel = list ? level + 1 : level;
                if (nextLevel > 7) fail('List nesting exceeds eight levels');
                const initial = record(node.attrs)?.start;
                const firstNode = record(children(node)[0]);
                const firstItem = firstNode?.type === 'listItem' ? record(children(firstNode)[0]) : firstNode;
                const hasMappedStart = !!firstNode && (firstNode.type === 'listItem' && !children(firstNode).length
                    || firstItem?.type === 'paragraph' || firstItem?.type === 'text' || firstItem?.type === 'hardBreak');
                withFields(node, ['type', 'content'], (key, value) => kind === 'ol' && key === 'start' && typeof value === 'number' && Number.isFinite(value) && hasMappedStart, () => {
                    let first = true;
                    for (const child of children(node)) {
                        const initialStart = kind === 'ol' && first && typeof initial === 'number' && Number.isFinite(initial) ? initial : undefined;
                        visit(child, depth + 1, kind, nextLevel, initialStart); first = false;
                    }
                });
                return;
            }
            case 'listItem': {
                withFields(node, ['type', 'content'], (key, value) => !children(node).length && directionAttribute(key, value), () => {
                    let first = true;
                    for (const child of children(node)) { visit(child, depth + 1, list, level, first ? start : undefined); first = false; }
                    if (first) inline([], list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1);
                });
                return;
            }
            case 'text': case 'hardBreak': inline([node], list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1); return;
            default: {
                const mark = { type: 'unsupported', node };
                if (originals) originals.set(mark, parseJson(`{"type":"unsupported","node":${raw(node, originals)}}`).raw());
                inline([{ type: 'text', text: collect(node, depth + 1), marks: [mark] }], 'p', 0, direction(node), undefined, depth + 1);
                repairs.push('Preserved an unsupported block node');
            }
        }
    };
    try {
        if (typeof input === 'string') inline([{ type: 'text', text: input }], 'p', 0, 'auto', undefined, 0);
        else if (input === null || input === undefined) inline([], 'p', 0, 'auto', undefined, 0);
        else visit(input, 0);
        if (!blocks.length) inline([], 'p', 0, 'auto', undefined, 0);
        if (replaced) repairs.push(`Replaced ${replaced} lone surrogate${replaced === 1 ? '' : 's'}`);
        if (controls) repairs.push(`Replaced ${controls} unsupported control character${controls === 1 ? '' : 's'}`);
        if (preservedFields) repairs.push(`Preserved fields on ${preservedFields} legacy rich node${preservedFields === 1 ? '' : 's'}`);
        return { text: normalizeRichText({ blocks }), repairs, unrepresentable };
    } catch (error) {
        unrepresentable.push(error instanceof Error ? error.message : 'Rich text could not be represented');
        const text: RichText = { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] };
        return { text, repairs, unrepresentable };
    }
}

/** Pass lexical spans when the legacy reader still has them; unknown carriers keep their original tokens. */
export function convertLegacyRichSpan(root: JsonSpan): RichImportResult {
    try {
        const originals = new WeakMap<object, RawJson | JsonSpan>(), pending: JsonSpan[] = [root];
        let count = 0;
        while (pending.length) {
            const span = pending.pop()!;
            if (++count > 200_000) throw new RangeError('Rich text structure exceeds safe limits');
            if (span.kind !== 'object' && span.kind !== 'array') continue;
            const value = span.value();
            if (typeof value !== 'object' || value === null) continue;
            originals.set(value, span);
            if (span.kind === 'array') for (const child of span.items()) pending.push(child);
            else for (const child of span.fieldMap().values()) pending.push(child);
        }
        return convertLegacyRichText(root.value(), originals);
    } catch (error) {
        return { text: { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] },
            repairs: [], unrepresentable: [error instanceof Error ? error.message : 'Rich text could not be represented'] };
    }
}
