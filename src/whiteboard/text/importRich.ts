import { parseJson, parseJsonIncremental, type JsonSpan } from '../format/jsonRead';
import type { RawJson } from '../model/json';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { normalizeRichTextSteps, type Block, type Marks, type RichText, type Run } from './richText';
import type { RichImportResult } from './rich';
import { repairLegacyCharacterSteps } from './repair';
import type { PlainTextOptions } from './plainText';
import { materializeLegacySpan, RichImportSchedulerError, type LegacyFields } from './legacySpanMaterialize';
import { encodeOpaqueJsonSteps } from './opaqueJson';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null;
}
function children(value: RecordValue): readonly unknown[] { return Array.isArray(value.content) ? value.content : []; }
type ImportWork = { readonly kind: 'raw'; readonly span: JsonSpan } | { readonly kind: 'parse'; readonly text: string };
type ImportSteps<T> = Generator<ImportWork | void, T, RawJson | undefined>;
function requireRaw(value: RawJson | undefined): RawJson {
    if (value === undefined) throw new Error('Missing rich import raw result');
    return value;
}
function* raw(value: unknown, originals?: WeakMap<object, RawJson | JsonSpan>): ImportSteps<RawJson> {
    if (typeof value === 'object' && value !== null) {
        const original = originals?.get(value);
        if (original !== undefined) {
            const encoded = typeof original === 'string' ? original : requireRaw(yield { kind: 'raw', span: original });
            if (encoded.length > MAX_TEXT_LENGTH * 4) throw new RangeError('Unsupported rich data exceeds preservation limit');
            return encoded;
        }
    }
    const encoded = yield* encodeOpaqueJsonSteps(value);
    return requireRaw(yield { kind: 'parse', text: encoded });
}
function validLink(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048 || /\p{Cc}/u.test(value)) return false;
    try {
        const url = new URL(value);
        return !url.username && !url.password && (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:');
    } catch { return false; }
}
/** Data-only ProseMirror mapping; unrepresentable input must keep its legacy source read-only. */
function* convertSteps(input: unknown, originals?: WeakMap<object, RawJson | JsonSpan>, sourceFields?: LegacyFields): ImportSteps<RichImportResult> {
    const repairs: string[] = [], unrepresentable: string[] = [], blocks: Block[] = [];
    let visited = 0, work = 0, total = 0, replaced = 0, controls = 0, preservedFields = 0, preservedBytes = 0;
    const fail = (message: string): never => { throw new Error(message); };
    const account = (depth: number) => {
        if (++visited > 200_000 || depth > 64) fail('Rich text structure exceeds safe limits');
    };
    const clean = function* (text: string): Generator<void, string> {
        const fixed = yield* repairLegacyCharacterSteps(text, MAX_TEXT_LENGTH - total);
        replaced += fixed.surrogates; controls += fixed.controls;
        // Each emitted block contributes its separator in push(), not here as well.
        total += fixed.contentLength;
        return fixed.text;
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
    const unknownFields = function* (object: RecordValue, keep: (key: string, value: unknown) => boolean): ImportSteps<string | null> {
        const original = originals?.get(object);
        const fields: string[] = [];
        let size = 2;
        const add = (field: string) => {
            size += field.length + (fields.length ? 1 : 0);
            if (size > MAX_TEXT_LENGTH * 4 - preservedBytes) fail('Unsupported rich node fields exceed preservation limit');
            fields.push(field);
        };
        const indexed = sourceFields?.get(object);
        if (indexed) {
            for (const field of indexed) {
                if ((++work & 255) === 0) yield;
                if (work > 1_000_000) fail('Rich text structure exceeds safe limits');
                if (keep(field.key, object[field.key])) {
                    const encoded = requireRaw(yield { kind: 'raw', span: field.span });
                    add(field.prefix + encoded);
                }
            }
        } else if (original && typeof original !== 'string' && original.kind === 'object') {
            let previous = original.start + 1;
            for (const [key, span] of original.fields()) {
                if ((++work & 255) === 0) yield;
                if (work > 1_000_000) fail('Rich text structure exceeds safe limits');
                let start = previous;
                while (start < span.start && /[\s,]/.test(original.source[start])) start++;
                if (keep(key, object[key])) {
                    const encoded = requireRaw(yield { kind: 'raw', span });
                    add(original.source.slice(start, span.start) + encoded);
                }
                previous = span.end;
            }
        } else {
            for (const key in object) {
                if ((++work & 255) === 0) yield;
                if (work > 1_000_000) fail('Rich text structure exceeds safe limits');
                if (!Object.hasOwn(object, key)) fail('Inherited rich node fields cannot be preserved');
                if (keep(key, object[key])) {
                    const name = yield* encodeOpaqueJsonSteps(key);
                    const encoded = yield* raw(object[key], originals);
                    add(`${name}:${encoded}`);
                }
            }
        }
        return fields.length ? `{${fields.join(',')}}` : null;
    };
    const extras = function* (node: RecordValue, fields: readonly string[], attributes: (key: string, value: unknown) => boolean): ImportSteps<RawJson | undefined> {
        const unknown = yield* unknownFields(node, (key, value) => {
            if (key === 'attrs') return value !== undefined && value !== null && !record(value);
            if (key === 'content' && fields.includes(key)) return !Array.isArray(value);
            return !fields.includes(key) && key !== 'attrs';
        });
        const attrs = record(node.attrs);
        const unknownAttrs = attrs ? (yield* unknownFields(attrs, (key, value) => !attributes(key, value))) : null;
        if (!unknown && !unknownAttrs) return undefined;
        const data = `[{"type":"legacy-node-fields","nodeType":${JSON.stringify(node.type ?? null)}${unknown ? `,"fields":${unknown}` : ''}${unknownAttrs ? `,"attrs":${unknownAttrs}` : ''}}]`;
        if (data.length > MAX_TEXT_LENGTH * 4 - preservedBytes) fail('Unsupported rich node fields exceed preservation limit');
        preservedFields++;
        return accountOpaque(requireRaw(yield { kind: 'parse', text: data }));
    };
    const attach = (index: number, data: RawJson | undefined) => {
        if (data === undefined) return;
        const block = blocks[index];
        blocks[index] = { ...block, runs: [{ text: '', marks: { x: data } }, ...block.runs] };
    };
    const directionAttribute = (key: string, value: unknown) => key === 'dir' && (value === 'auto' || value === 'ltr' || value === 'rtl');
    const noAttributes = () => false;
    const marks = function* (value: unknown): ImportSteps<Marks> {
        const result: { b?: true; i?: true; u?: true; s?: true; code?: true; hl?: true; link?: string; x?: RawJson } = {};
        const extra: unknown[] = [];
        if (value === undefined) return result;
        if (!Array.isArray(value)) { extra.push(value); }
        else for (const item of value) {
            if ((++work & 255) === 0) yield;
            if (work > 1_000_000) fail('Rich text structure exceeds safe limits');
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
                for (const key in mark) {
                    if ((++work & 255) === 0) yield;
                    if (work > 1_000_000) fail('Rich text structure exceeds safe limits');
                    if (!Object.hasOwn(mark, key) || (key !== 'type' && key !== 'attrs')) preserve = true;
                }
                if (mark.attrs !== undefined && mark.attrs !== null && !attrs) preserve = true;
                if (attrs) for (const key in attrs) {
                    if ((++work & 255) === 0) yield;
                    if (work > 1_000_000) fail('Rich text structure exceeds safe limits');
                    if (!Object.hasOwn(attrs, key) || mark.type !== 'link' || key !== 'href') preserve = true;
                }
            }
            if (!known || preserve) extra.push(item);
        }
        if (extra.length) {
            const values: RawJson[] = [];
            let size = 2;
            for (const item of extra) {
                if ((++work & 255) === 0) yield;
                if (work > 1_000_000) fail('Rich text structure exceeds safe limits');
                const encoded = yield* raw(item, originals);
                size += encoded.length + (values.length ? 1 : 0);
                if (size > MAX_TEXT_LENGTH * 4 - preservedBytes) fail('Unsupported rich marks exceed preservation limit');
                values.push(encoded);
            }
            result.x = accountOpaque(requireRaw(yield { kind: 'parse', text: `[${values.join(',')}]` }));
            repairs.push('Preserved unsupported inline marks');
        }
        return result;
    };
    const collect = function* (node: unknown, depth: number): Generator<void, string> {
        account(depth);
        if ((visited & 255) === 0) yield;
        const data = record(node);
        if (!data) return typeof node === 'string' ? node : '';
        if (data.type === 'text') return typeof data.text === 'string' ? data.text : '';
        if (data.type === 'hardBreak') return '\u2028';
        const parts: string[] = [];
        let length = 0;
        for (const child of children(data)) {
            const part = yield* collect(child, depth + 1);
            length += part.length;
            if (length > MAX_TEXT_LENGTH * 2) fail('Rich text exceeds safe limits');
            parts.push(part);
        }
        return parts.join('');
    };
    const inline = function* (source: readonly unknown[], kind: Block['kind'], level: number, dir: Block['dir'], start: number | undefined, depth: number): ImportSteps<void> {
        let runs: Run[] = [];
        let first = true, endedCR = false;
        const flush = () => {
            push({ kind, level, dir, ...(first && start !== undefined ? { start } : {}), runs: runs.length ? runs : [{ text: '', marks: {} }] });
            runs = []; first = false;
        };
        const append = function* (value: string, styling: Marks): Generator<void, void> {
            // A legacy producer can split CRLF at a mark boundary. It is still
            // one projected separator, even when empty carrier runs intervene.
            if (endedCR && value.startsWith('\n')) { value = value.slice(1); endedCR = false; }
            if (value.length) endedCR = value.endsWith('\r');
            const normalized = yield* clean(value);
            let lineStart = 0, next = normalized.indexOf('\n'), lines = 0;
            if (next < 0) { runs.push({ text: normalized, marks: styling }); return; }
            if (styling.x !== undefined) fail('Cannot split an unsupported rich run safely');
            while (next >= 0) {
                if (next > lineStart) runs.push({ text: normalized.slice(lineStart, next), marks: styling });
                flush();
                lineStart = next + 1; next = normalized.indexOf('\n', lineStart);
                if ((++lines & 255) === 0) yield;
            }
            if (lineStart < normalized.length) runs.push({ text: normalized.slice(lineStart), marks: styling });
        };
        for (const item of source) {
            account(depth);
            if ((visited & 255) === 0) yield;
            const node = record(item);
            if (node?.type === 'text' && typeof node.text === 'string') {
                const data = yield* extras(node, ['type', 'text', 'marks'], noAttributes);
                if (data !== undefined) runs.push({ text: '', marks: { x: data } });
                const styling = yield* marks(node.marks);
                yield* append(node.text, styling);
            } else if (node?.type === 'hardBreak') {
                const data = yield* extras(node, ['type'], noAttributes);
                if (data !== undefined) runs.push({ text: '', marks: { x: data } });
                yield* append('\u2028', {});
            } else {
                const value = yield* collect(item, depth + 1);
                const encoded = yield* raw(item, originals);
                yield* append(value, { x: accountOpaque(encoded) });
                repairs.push('Preserved an unsupported inline node');
            }
        }
        flush();
    };
    const direction = (node: RecordValue): Block['dir'] => {
        const dir = record(node.attrs)?.dir;
        return dir === 'ltr' || dir === 'rtl' ? dir : 'auto';
    };
    const withFields = function* (node: RecordValue, fields: readonly string[], attributes: (key: string, value: unknown) => boolean,
        emit: () => ImportSteps<void>): ImportSteps<void> {
        const data = yield* extras(node, fields, attributes);
        const first = blocks.length;
        yield* emit();
        if (data !== undefined && first === blocks.length) yield* inline([], 'p', 0, 'auto', undefined, 0);
        attach(first, data);
    };
    const visit = function* (value: unknown, depth: number, list: 'ul' | 'ol' | null = null, level = 0, start?: number): ImportSteps<void> {
        account(depth);
        if ((visited & 255) === 0) yield;
        const node = record(value);
        if (!node) { if (typeof value === 'string') yield* inline([{ type: 'text', text: value }], 'p', 0, 'auto', undefined, depth + 1); else fail('Invalid rich text node'); return; }
        switch (node.type) {
            case 'doc':
                yield* withFields(node, ['type', 'content'], noAttributes, function* () { for (const child of children(node)) yield* visit(child, depth + 1); });
                return;
            case 'paragraph':
                yield* withFields(node, ['type', 'content'], directionAttribute, () => inline(children(node), list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1));
                return;
            case 'heading': {
                const n = record(node.attrs)?.level;
                const valid = typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 6;
                yield* withFields(node, ['type', 'content'], (key, value) => directionAttribute(key, value) || (key === 'level' && valid), function* () {
                    if (!valid) { repairs.push('Invalid heading level became a paragraph'); yield* inline(children(node), 'p', 0, direction(node), undefined, depth + 1); }
                    else yield* inline(children(node), `h${n}` as Block['kind'], 0, direction(node), undefined, depth + 1);
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
                yield* withFields(node, ['type', 'content'], (key, value) => kind === 'ol' && key === 'start' && typeof value === 'number' && Number.isFinite(value) && hasMappedStart, function* () {
                    let first = true;
                    for (const child of children(node)) {
                        const initialStart = kind === 'ol' && first && typeof initial === 'number' && Number.isFinite(initial) ? initial : undefined;
                        yield* visit(child, depth + 1, kind, nextLevel, initialStart); first = false;
                    }
                });
                return;
            }
            case 'listItem': {
                yield* withFields(node, ['type', 'content'], (key, value) => !children(node).length && directionAttribute(key, value), function* () {
                    let first = true;
                    for (const child of children(node)) { yield* visit(child, depth + 1, list, level, first ? start : undefined); first = false; }
                    if (first) yield* inline([], list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1);
                });
                return;
            }
            case 'text': case 'hardBreak': yield* inline([node], list ?? 'p', list ? level : 0, direction(node), list === 'ol' ? start : undefined, depth + 1); return;
            default: {
                const mark = { type: 'unsupported', node };
                if (originals) {
                    const encoded = yield* raw(node, originals);
                    originals.set(mark, requireRaw(yield { kind: 'parse', text: `{"type":"unsupported","node":${encoded}}` }));
                }
                const content = yield* collect(node, depth + 1);
                yield* inline([{ type: 'text', text: content, marks: [mark] }], 'p', 0, direction(node), undefined, depth + 1);
                repairs.push('Preserved an unsupported block node');
            }
        }
    };
    try {
        if (typeof input === 'string') yield* inline([{ type: 'text', text: input }], 'p', 0, 'auto', undefined, 0);
        else if (input === null || input === undefined) yield* inline([], 'p', 0, 'auto', undefined, 0);
        else yield* visit(input, 0);
        if (!blocks.length) yield* inline([], 'p', 0, 'auto', undefined, 0);
        if (replaced) repairs.push(`Replaced ${replaced} lone surrogate${replaced === 1 ? '' : 's'}`);
        if (controls) repairs.push(`Replaced ${controls} unsupported control character${controls === 1 ? '' : 's'}`);
        if (preservedFields) repairs.push(`Preserved fields on ${preservedFields} legacy rich node${preservedFields === 1 ? '' : 's'}`);
        const text = yield* normalizeRichTextSteps({ blocks });
        return { text, repairs, unrepresentable };
    } catch (error) {
        unrepresentable.push(error instanceof Error ? error.message : 'Rich text could not be represented');
        const text: RichText = { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] };
        return { text, repairs, unrepresentable };
    }
}

function finish(steps: ImportSteps<RichImportResult>): RichImportResult {
    let value: RawJson | undefined, failure: unknown, failed = false, completed = false;
    try {
        for (;;) {
            const step = failed ? steps.throw(failure) : steps.next(value);
            failed = false; value = undefined;
            if (step.done) { completed = true; return step.value; }
            if (step.value) try {
                value = step.value.kind === 'raw' ? step.value.span.raw() : parseJson(step.value.text).raw();
            } catch (error) { failure = error; failed = true; }
        }
    } finally {
        if (!completed) try { steps.return(undefined as unknown as RichImportResult); } catch { /* Preserve the original error. */ }
    }
}
async function finishCooperative(steps: ImportSteps<RichImportResult>, options: PlainTextOptions): Promise<RichImportResult> {
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid rich import time slice');
    let started = performance.now(), value: RawJson | undefined, failure: unknown, failed = false, completed = false;
    const cooperate = async () => {
        options.signal?.throwIfAborted();
        if (performance.now() - started < budget) return;
        try { await options.cooperate(); }
        catch (error) { throw new RichImportSchedulerError(error); }
        options.signal?.throwIfAborted();
        started = performance.now();
    };
    try {
        for (;;) {
            options.signal?.throwIfAborted();
            const step = failed ? steps.throw(failure) : steps.next(value);
            failed = false; value = undefined;
            if (step.done) { completed = true; return step.value; }
            if (step.value) {
                try {
                    if (step.value.kind === 'raw') value = await step.value.span.rawIncremental(cooperate);
                    else {
                        const span = await parseJsonIncremental(step.value.text, cooperate);
                        value = await span.rawIncremental(cooperate);
                    }
                } catch (error) {
                    options.signal?.throwIfAborted();
                    if (error instanceof RichImportSchedulerError) throw error.original;
                    failure = error; failed = true;
                }
            } else {
                try { await cooperate(); }
                catch (error) { if (error instanceof RichImportSchedulerError) throw error.original; throw error; }
            }
        }
    } finally {
        if (!completed) try { steps.return(undefined as unknown as RichImportResult); } catch { /* Preserve the original error. */ }
    }
}

/** Data-only ProseMirror mapping; unrepresentable input keeps its legacy source read-only. */
export function convertLegacyRichText(input: unknown, originals?: WeakMap<object, RawJson | JsonSpan>): RichImportResult {
    return finish(convertSteps(input, originals));
}
export function convertLegacyRichTextCooperative(input: unknown, options: PlainTextOptions,
    originals?: WeakMap<object, RawJson | JsonSpan>): Promise<RichImportResult> {
    return finishCooperative(convertSteps(input, originals), options);
}

function* spanSteps(root: JsonSpan): ImportSteps<RichImportResult> {
    try {
        const originals = new WeakMap<object, RawJson | JsonSpan>(), pending: JsonSpan[] = [root];
        let scheduled = 1, work = 0;
        while (pending.length) {
            const span = pending.pop()!;
            if ((++work & 255) === 0) yield;
            if (span.kind !== 'object' && span.kind !== 'array') continue;
            const value = span.value();
            if (typeof value !== 'object' || value === null) continue;
            originals.set(value, span);
            if (span.kind === 'array') {
                for (const child of span.items()) {
                    if (++scheduled > 200_000) throw new RangeError('Rich text structure exceeds safe limits');
                    pending.push(child);
                    if ((++work & 255) === 0) yield;
                }
            } else {
                const keys = new Set<string>();
                for (const [key, child] of span.fields()) {
                    if (keys.has(key)) throw new RangeError('Duplicate rich JSON property cannot be preserved');
                    keys.add(key);
                    if (++scheduled > 200_000) throw new RangeError('Rich text structure exceeds safe limits');
                    pending.push(child);
                    if ((++work & 255) === 0) yield;
                }
            }
        }
        return yield* convertSteps(root.value(), originals);
    } catch (error) {
        return { text: { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] },
            repairs: [], unrepresentable: [error instanceof Error ? error.message : 'Rich text could not be represented'] };
    }
}

/** Lexical spans preserve unknown tokens; no partial conversion is returned after cancellation. */
export function convertLegacyRichSpan(root: JsonSpan): RichImportResult { return finish(spanSteps(root)); }
export async function convertLegacyRichSpanCooperative(root: JsonSpan, options: PlainTextOptions): Promise<RichImportResult> {
    let materialized: Awaited<ReturnType<typeof materializeLegacySpan>>;
    try { materialized = await materializeLegacySpan(root, options); }
    catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof RichImportSchedulerError) throw error.original;
        return { text: { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] },
            repairs: [], unrepresentable: [error instanceof Error ? error.message : 'Rich text could not be represented'] };
    }
    return finishCooperative(convertSteps(materialized.value, materialized.originals, materialized.fields), options);
}
