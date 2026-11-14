import { FORMAT_LIMITS } from '../format/schema';
import type { BoardKind } from '../model/doc';
import type { ParseNativeRequest } from './nativeParseTypes';

// Native-format §7 and C5: the worker receives copied bytes, never a disk File.
export function validateNativeRequest(payload: unknown): ParseNativeRequest {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Invalid native request');
    const keys = Reflect.ownKeys(payload);
    if (keys.some(key => typeof key !== 'string' || !['bytes', 'expectedKind', 'pdfPages'].includes(key))) throw new TypeError('Unknown native request field');
    const get = (key: string): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(payload, key);
        if (descriptor && !('value' in descriptor)) throw new TypeError('Native request contains an accessor');
        return descriptor?.value;
    };
    const bytes = get('bytes'), kind = get('expectedKind'), pages = get('pdfPages');
    if (!(bytes instanceof Blob) || (typeof File !== 'undefined' && bytes instanceof File) || bytes.size > FORMAT_LIMITS.fileBytes) throw new TypeError('Native request requires a bounded copied Blob');
    if (kind !== undefined && kind !== 'whiteboard' && kind !== 'notebook' && kind !== 'pdf-ink') throw new TypeError('Invalid expected board kind');
    let copied: readonly (readonly [number, number])[] | undefined;
    if (pages !== undefined) {
        if (!Array.isArray(pages) || pages.length < 1 || pages.length > FORMAT_LIMITS.pdfPages) throw new TypeError('Invalid PDF pages');
        const result: (readonly [number, number])[] = [];
        for (const page of pages) {
            if (!Array.isArray(page) || page.length !== 2 || ![page[0], page[1]].every(value => typeof value === 'number'
                && Number.isFinite(value) && value > 0 && value <= FORMAT_LIMITS.pdfPageSize)) throw new TypeError('Invalid PDF page dimensions');
            result.push(Object.freeze([page[0], page[1]] as [number, number]));
        }
        copied = Object.freeze(result);
    }
    return Object.freeze({ bytes, ...(kind === undefined ? {} : { expectedKind: kind as BoardKind }),
        ...(copied === undefined ? {} : { pdfPages: copied }) });
}
