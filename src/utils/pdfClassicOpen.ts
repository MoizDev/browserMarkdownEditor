// Lazy PDF-only entry point. No caller can override the versioned asset policy
// or accidentally transfer the bytes another surface/save still needs.
import { getDocument, version } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { classicAssets } from 'virtual:pdfjs-classic-assets';
import { pdfWorker } from './pdfWorker';

export interface ClassicPdfDiagnostic {
    code: 'image-decode-failed' | 'asset-load-failed' | 'worker-startup-failed' | 'worker-failed' | 'message-contract-failed' | 'render-failed';
    pageIndex?: number;
}
interface ClassicPdfOpen {
    bytes: Uint8Array;
    purpose: 'viewer' | 'attachments' | 'annotation-backdrop' | 'annotation-text' | 'agent';
    diagnostic?: (diagnostic: ClassicPdfDiagnostic) => void;
    password?: string;
    signal?: AbortSignal;
}

function assetUrl(suffix: string): string {
    const base = new URL(import.meta.env.BASE_URL, document.baseURI);
    const url = new URL(suffix, base);
    if (url.origin !== location.origin || !url.pathname.endsWith('/')) throw new Error('Classic PDF assets must be same-origin directories');
    return url.href;
}

/** Own one real loading task, never a proxy per surface. Cancellation while
 * waiting for shared startup must not create a late, ownerless document. */
export async function openClassicPdf({ bytes, diagnostic, password, signal }: ClassicPdfOpen): Promise<PDFDocumentLoadingTask> {
    signal?.throwIfAborted();
    if (version !== classicAssets.version) throw new Error('Classic PDF runtime version mismatch');
    const worker = pdfWorker();
    await worker.promise;
    signal?.throwIfAborted();
    const task = getDocument({
        data: bytes.slice(), worker, password,
        wasmUrl: assetUrl(classicAssets.directories.wasm),
        cMapUrl: assetUrl(classicAssets.directories.cmaps),
        standardFontDataUrl: assetUrl(classicAssets.directories.standard_fonts),
        iccUrl: assetUrl(classicAssets.directories.iccs),
        cMapPacked: true, useWasm: true, enableXfa: false, stopAtErrors: true,
        maxImageSize: -1, canvasMaxAreaInBytes: -1,
    });
    // 6.1.200 has no isEvalSupported option. An unsupported option would make
    // no security guarantee; the pinned bundle/browser runs forbid eval and
    // Function instead. No scripting/QuickJS module is imported or emitted.
    void diagnostic; // Typed propagation is the next P-02 milestone.
    void task.promise.catch(() => {});
    const destroy = task.destroy.bind(task);
    const cancel = () => { void task.destroy().catch(() => {}); };
    task.destroy = async () => {
        signal?.removeEventListener('abort', cancel);
        await destroy();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    return task;
}
