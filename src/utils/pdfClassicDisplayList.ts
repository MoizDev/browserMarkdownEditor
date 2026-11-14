import { version } from 'pdfjs-dist';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';

/** Read-only access audited against pdf.js 6.1.200 (Apache-2.0),
 * display/api.js RenderTask and InternalRenderTask. A successful render is
 * required: a partial list cannot establish a page capability. */
export function completedClassicDisplayList(task: RenderTask): Awaited<ReturnType<PDFPageProxy['getOperatorList']>> | undefined {
    if (version !== '6.1.200') return undefined;
    const internal = (task as unknown as { _internalRenderTask?: { operatorList?: unknown } })._internalRenderTask;
    const list = internal?.operatorList as { fnArray?: unknown; argsArray?: unknown; lastChunk?: unknown } | undefined;
    if (!list || list.lastChunk !== true || !Array.isArray(list.fnArray) || !Array.isArray(list.argsArray)
        || list.fnArray.length !== list.argsArray.length) return undefined;
    return list as unknown as Awaited<ReturnType<PDFPageProxy['getOperatorList']>>;
}
