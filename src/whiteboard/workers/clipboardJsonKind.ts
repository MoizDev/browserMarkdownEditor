import type { WorkerContext } from '../../platform/workers';
import { JsonReadError, parseJsonIncremental, type JsonSpan } from '../format/jsonRead';
import { utf8LengthAsync } from '../format/writeTypes';
import { SECURITY_LIMITS } from '../security/limits';

export type ClipboardJsonKind = 'excalidraw' | 'native-records' | null;
const LIMIT = SECURITY_LIMITS.recordBytes;
async function shortString(span: JsonSpan | undefined, limit: number, context: WorkerContext): Promise<string | null> {
    if (!span || span.kind !== 'string' || span.end - span.start > limit * 6 + 2) return null;
    try { return await span.stringIncremental(limit, context.slice); }
    catch (error) { if (error instanceof JsonReadError && error.code === 'limit') return null; throw error; }
}
async function nativeRow(line: string, context: WorkerContext): Promise<boolean> {
    const bytes = await utf8LengthAsync(line, LIMIT, { signal: context.signal, cooperate: context.slice });
    if (!bytes.ok) {
        if (bytes.error.code === 'limit') throw new RangeError('Clipboard native record exceeds its limit');
        return false;
    }
    let root: JsonSpan;
    try { root = await parseJsonIncremental(line, context.slice); }
    catch (error) { if (error instanceof JsonReadError && error.code === 'syntax') return false; throw error; }
    if (root.kind !== 'object') return false;
    let type: JsonSpan | undefined, id: JsonSpan | undefined, kind: JsonSpan | undefined, parent: JsonSpan | undefined, order: JsonSpan | undefined, mime: JsonSpan | undefined;
    const seen = new Set<string>();
    for await (const [key, value] of root.fieldsIncremental(context.slice)) {
        if (seen.has(key)) return false; seen.add(key);
        if (key === 'type') type = value;
        else if (key === 'id') id = value;
        else if (key === 'kind') kind = value;
        else if (key === 'parent') parent = value;
        else if (key === 'order') order = value;
        else if (key === 'mime') mime = value;
    }
    const rowType = await shortString(type, 128, context), rowId = await shortString(id, SECURITY_LIMITS.idCharacters, context);
    if (!rowId) return false;
    if (rowType === 'media') return !!(await shortString(mime, 256, context));
    if (rowType !== 'node') return false;
    return !!(await shortString(kind, 128, context)) && !!(await shortString(parent, SECURITY_LIMITS.idCharacters, context))
        && !!(await shortString(order, 256, context));
}
export async function clipboardJsonKind(payload: unknown, context: WorkerContext): Promise<ClipboardJsonKind> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid clipboard JSON request');
    const { bytes } = payload as { bytes?: unknown };
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File) || bytes.size > LIMIT) throw new TypeError('Clipboard JSON requires bounded copied bytes');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await bytes.arrayBuffer());
    context.signal.throwIfAborted();
    let root: JsonSpan;
    try { root = await parseJsonIncremental(text, context.slice); }
    catch (error) { if (error instanceof JsonReadError && error.code === 'syntax') return null; throw error; }
    if (root.kind === 'object') {
        let type: JsonSpan | undefined, elements: JsonSpan | undefined, files: JsonSpan | undefined;
        const seen = new Set<string>();
        for await (const [key, value] of root.fieldsIncremental(context.slice)) {
            if (seen.has(key)) return null; seen.add(key);
            if (key === 'type') type = value; else if (key === 'elements') elements = value; else if (key === 'files') files = value;
        }
        if (type?.kind !== 'string' || elements?.kind !== 'array' || (files && files.kind !== 'object' && files.kind !== 'null')) return null;
        const marker = await shortString(type, 128, context);
        if (marker !== 'excalidraw/clipboard') return null;
        let count = 0;
        for await (const item of elements.itemsIncremental(context.slice)) {
            if (++count > SECURITY_LIMITS.clipboardNodes) throw new RangeError('Clipboard element count exceeds its limit');
            if (item.kind !== 'object') return null;
            if ((count & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
        }
        return 'excalidraw';
    }
    if (root.kind !== 'array') return null;
    let count = 0;
    for await (const item of root.itemsIncremental(context.slice)) {
        if (++count > SECURITY_LIMITS.clipboardRecords) throw new RangeError('Clipboard record count exceeds its limit');
        if (item.kind !== 'string') return null;
        const row = await item.stringIncremental(LIMIT, context.slice);
        if (!await nativeRow(row, context)) return null;
        if ((count & 63) === 0) { context.signal.throwIfAborted(); await context.slice(); }
    }
    return count ? 'native-records' : null;
}
