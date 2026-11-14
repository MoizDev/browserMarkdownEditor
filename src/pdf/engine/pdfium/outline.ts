import type { PageGeometry } from '../../../platform/types';
import { PdfEngineError } from '../types';
import type { RawOutlineNode } from '../types';
import type { PdfiumRuntime } from './loader';
import { pdfiumDestination } from './links';
import { readPdfiumUtf16, withPdfiumMemory } from './memory';

/** The document owns these bookmark handles; only copied strings and targets escape. */
export function pdfiumOutline(runtime: PdfiumRuntime, document: number, pageCount: number,
    geometryFor: (page: number) => PageGeometry, limits: { maxDepth: number; maxNodes: number }): RawOutlineNode[] {
    const maxDepth = Math.min(64, limits.maxDepth), maxNodes = Math.min(20_000, limits.maxNodes);
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 0) {
        throw new PdfEngineError('RangeError', 'Invalid PDF outline limit');
    }
    const title = (handle: number): string => {
        const bytes = runtime.call('FPDFBookmark_GetTitle', handle, 0, 0) >>> 0;
        if (!bytes) return '';
        if (bytes % 2 || bytes > 2050) throw new PdfEngineError('ResourceLimit', 'PDF outline title is too long');
        return withPdfiumMemory(runtime, bytes, pointer => {
            if ((runtime.call('FPDFBookmark_GetTitle', handle, pointer, bytes) >>> 0) !== bytes) throw new PdfEngineError('FileError', 'PDF outline title is unreadable');
            return readPdfiumUtf16(runtime, pointer, bytes);
        });
    };
    const result: RawOutlineNode[] = [], seen = new Set<number>();
    const first = runtime.call('FPDFBookmark_GetFirstChild', document, 0) >>> 0;
    const stack: Array<{ handle: number; depth: number; target: RawOutlineNode[] }> = first ? [{ handle: first, depth: 0, target: result }] : [];
    while (stack.length) {
        const { handle, depth, target } = stack.pop()!;
        if (depth > maxDepth || seen.size >= maxNodes) throw new PdfEngineError('ResourceLimit', 'PDF outline exceeds its limit');
        if (seen.has(handle)) throw new PdfEngineError('FileError', 'PDF outline contains a cycle');
        seen.add(handle);
        const direct = runtime.call('FPDFBookmark_GetDest', document, handle) >>> 0;
        const action = direct ? 0 : runtime.call('FPDFBookmark_GetAction', handle) >>> 0;
        const destination = direct || (action && runtime.call('FPDFAction_GetType', action) === 1
            ? runtime.call('FPDFAction_GetDest', document, action) >>> 0 : 0);
        const dest = pdfiumDestination(runtime, document, destination, pageCount, geometryFor);
        const node: RawOutlineNode = { title: title(handle), children: [], ...(dest ? { dest } : {}) };
        target.push(node);
        const next = runtime.call('FPDFBookmark_GetNextSibling', document, handle) >>> 0;
        const child = runtime.call('FPDFBookmark_GetFirstChild', document, handle) >>> 0;
        if (next) stack.push({ handle: next, depth, target });
        if (child) stack.push({ handle: child, depth: depth + 1, target: node.children });
    }
    return result;
}
