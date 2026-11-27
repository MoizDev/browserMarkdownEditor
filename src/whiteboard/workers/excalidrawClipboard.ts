import type { WorkerContext } from '../../platform/workers';
import { parseJsonIncremental, type JsonSpan } from '../format/jsonRead';
import { SECURITY_LIMITS } from '../security/limits';

export interface ExcalidrawWireFile { readonly fileId: string; readonly blob: Blob; readonly mimeHint: string }
export interface ExcalidrawWireDocument {
    readonly elements: readonly Readonly<Record<string, unknown>>[];
    readonly files: readonly ExcalidrawWireFile[];
}
const elementFields = new Set(['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle',
    'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'points', 'pressures', 'simulatePressure', 'closed', 'text', 'originalText',
    'fontFamily', 'fontSize', 'textAlign', 'verticalAlign', 'containerId', 'boundElements', 'startBinding', 'endBinding',
    'startArrowhead', 'endArrowhead', 'fileId', 'scale', 'isDeleted']);
async function value(span: JsonSpan, context: WorkerContext, budget: { remaining: number }, depth = 0): Promise<unknown> {
    if (depth > SECURITY_LIMITS.jsonDepth || --budget.remaining < 0) throw new RangeError('Excalidraw JSON is too complex');
    if ((budget.remaining & 255) === 0) { context.signal.throwIfAborted(); await context.slice(); }
    if (span.kind === 'string') return span.stringIncremental(SECURITY_LIMITS.recordBytes, context.slice);
    if (span.kind === 'number') return span.number();
    if (span.kind === 'boolean') return span.source[span.start] === 't';
    if (span.kind === 'null') return null;
    if (span.kind === 'array') {
        const items: unknown[] = [];
        for await (const item of span.itemsIncremental(context.slice)) items.push(await value(item, context, budget, depth + 1));
        return items;
    }
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for await (const [key, item] of span.fieldsIncremental(context.slice)) {
        if (Object.hasOwn(fields, key)) throw new TypeError('Duplicate Excalidraw field');
        fields[key] = await value(item, context, budget, depth + 1);
    }
    return fields;
}
async function dataUrl(source: string, context: WorkerContext, remaining: number): Promise<{ blob: Blob; mimeHint: string }> {
    const comma = source.indexOf(',');
    if (!/^data:/i.test(source) || comma < 5 || comma > 512) throw new TypeError('Invalid Excalidraw image data');
    const header = source.slice(5, comma).split(';'), mimeHint = header.shift()?.toLowerCase();
    const base64 = header.at(-1)?.toLowerCase() === 'base64'; if (base64) header.pop();
    if (!mimeHint || !/^image\/[a-z0-9.+-]+$/.test(mimeHint)
        || header.some(part => !/^[a-z0-9!#$&^.+-]+=[a-z0-9!#$&^.+%_-]+$/i.test(part))) throw new TypeError('Invalid Excalidraw image metadata');
    const encoded = source.slice(comma + 1), limit = Math.min(remaining, SECURITY_LIMITS.mediaBytes);
    let bytes: Uint8Array<ArrayBuffer>;
    if (base64) {
        if (encoded.length % 4 || encoded.length > 4 * Math.ceil(limit / 3)) throw new RangeError('Excalidraw image exceeds limits');
        let size = encoded.length / 4 * 3; if (encoded.endsWith('=')) size--; if (encoded.endsWith('==')) size--;
        if (size > limit) throw new RangeError('Excalidraw image exceeds limits');
        bytes = new Uint8Array(size); let used = 0;
        for (let offset = 0; offset < encoded.length; offset += 32768) {
            const chunk = encoded.slice(offset, offset + 32768);
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || (offset + 32768 < encoded.length && chunk.includes('='))) throw new TypeError('Invalid Excalidraw image base64');
            const binary = atob(chunk);
            for (let i = 0; i < binary.length; i++) bytes[used++] = binary.charCodeAt(i);
            context.signal.throwIfAborted(); await context.slice();
        }
        if (used !== size) throw new TypeError('Invalid Excalidraw image length');
    } else {
        const encoder = new TextEncoder(); let count = 0;
        for (let pass = 0; pass < 2; pass++) {
            let at = 0, nextYield = 4096;
            for (let i = 0; i < encoded.length; i++) {
                const c = encoded.charCodeAt(i);
                if (c < 128) {
                    let byte = c;
                    if (c === 37) { const hex = encoded.slice(i + 1, i + 3); if (!/^[0-9a-f]{2}$/i.test(hex)) throw new TypeError('Invalid Excalidraw image escape'); byte = parseInt(hex, 16); i += 2; }
                    if (at >= limit) throw new RangeError('Excalidraw image exceeds limits');
                    if (pass) bytes![at] = byte; at++;
                } else {
                    const cp = encoded.codePointAt(i)!, buffer = encoder.encode(String.fromCodePoint(cp)); if (cp > 0xffff) i++;
                    if (buffer.length > limit - at) throw new RangeError('Excalidraw image exceeds limits');
                    if (pass) bytes!.set(buffer, at); at += buffer.length;
                }
                if (i >= nextYield) { nextYield = i + 4096; context.signal.throwIfAborted(); await context.slice(); }
            }
            if (!pass) { count = at; bytes = new Uint8Array(count); }
            else if (at !== count) throw new TypeError('Invalid Excalidraw image length');
        }
    }
    return { blob: new Blob([bytes!], { type: mimeHint }), mimeHint };
}
export async function excalidrawClipboard(payload: unknown, context: WorkerContext): Promise<ExcalidrawWireDocument> {
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid Excalidraw clipboard request');
    const bytes = (payload as { bytes?: unknown }).bytes;
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File) || bytes.size > SECURITY_LIMITS.recordBytes) throw new TypeError('Excalidraw input must be a bounded copied Blob');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await bytes.arrayBuffer()); context.signal.throwIfAborted();
    const root = await parseJsonIncremental(text, context.slice);
    if (root.kind !== 'object') throw new TypeError('Excalidraw clipboard object required');
    let marker: JsonSpan | undefined, elementsSpan: JsonSpan | undefined, filesSpan: JsonSpan | undefined;
    const seen = new Set<string>();
    for await (const [key, item] of root.fieldsIncremental(context.slice)) {
        if (seen.has(key)) throw new TypeError('Duplicate Excalidraw root field'); seen.add(key);
        if (key === 'type') marker = item; else if (key === 'elements') elementsSpan = item; else if (key === 'files') filesSpan = item;
    }
    if (marker?.kind !== 'string' || await marker.stringIncremental(128, context.slice) !== 'excalidraw/clipboard'
        || elementsSpan?.kind !== 'array' || (filesSpan && filesSpan.kind !== 'object' && filesSpan.kind !== 'null')) throw new TypeError('Invalid Excalidraw clipboard envelope');
    const elements: Readonly<Record<string, unknown>>[] = [], referenced = new Set<string>(), budget = { remaining: SECURITY_LIMITS.records };
    for await (const item of elementsSpan.itemsIncremental(context.slice)) {
        if (item.kind !== 'object') throw new TypeError('Invalid Excalidraw element');
        if (elements.length >= SECURITY_LIMITS.clipboardNodes) throw new RangeError('Excalidraw element count exceeds limits');
        const element: Record<string, unknown> = Object.create(null) as Record<string, unknown>, keys = new Set<string>();
        for await (const [key, field] of item.fieldsIncremental(context.slice)) {
            if (keys.has(key)) throw new TypeError('Duplicate Excalidraw element field'); keys.add(key);
            if (elementFields.has(key)) element[key] = await value(field, context, budget);
        }
        if (element.type === 'image' && typeof element.fileId === 'string' && element.fileId.length <= SECURITY_LIMITS.idCharacters) referenced.add(element.fileId);
        elements.push(element);
        if ((elements.length & 63) === 0) { context.signal.throwIfAborted(); await context.slice(); }
    }
    const files: ExcalidrawWireFile[] = []; let total = 0;
    if (filesSpan?.kind === 'object') {
        const keys = new Set<string>();
        for await (const [fileId, file] of filesSpan.fieldsIncremental(context.slice)) {
            if (keys.has(fileId)) throw new TypeError('Duplicate Excalidraw file id'); keys.add(fileId);
            if (!referenced.has(fileId) || file.kind !== 'object') continue;
            let data: JsonSpan | undefined;
            for await (const [key, field] of file.fieldsIncremental(context.slice)) if (key === 'dataURL') { if (data) throw new TypeError('Duplicate Excalidraw data URL'); data = field; }
            if (!data || data.kind !== 'string') continue;
            if (files.length >= SECURITY_LIMITS.mediaBatch) throw new RangeError('Excalidraw image count exceeds limits');
            const source = await data.stringIncremental(SECURITY_LIMITS.recordBytes, context.slice);
            if (!/^data:/i.test(source)) continue;
            let image: Awaited<ReturnType<typeof dataUrl>>;
            try { image = await dataUrl(source, context, SECURITY_LIMITS.inlineMediaBytes - total); }
            catch (error) { context.signal.throwIfAborted(); if (error instanceof RangeError) throw error; continue; }
            total += image.blob.size; files.push({ fileId, ...image });
            await context.slice();
        }
    }
    context.signal.throwIfAborted();
    return { elements, files };
}
