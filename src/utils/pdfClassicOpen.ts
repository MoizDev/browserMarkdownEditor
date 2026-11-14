// Lazy PDF-only entry point. No caller can override the versioned asset policy
// or accidentally transfer bytes another surface/save still needs. The actual
// pdf.js task/proxy objects are returned unchanged; lifecycle guards live here.
import { getDocument, version } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { classicAssets } from 'virtual:pdfjs-classic-assets';
import { readyClassicWorker, prepareClassicWorkerRetry } from './pdfWorker';
import type { ClassicWorkerConnection } from './pdfWorker';
import { ClassicPdfError, CLASSIC_PDF_PROGRESS_NOTICE_MS, createClassicPdfHealth, recordClassicRenderFailure } from './pdfClassicHealth';
import type { ClassicPdfDiagnostic, ClassicPdfHealth } from './pdfClassicHealth';

interface ClassicPdfOpen {
    bytes: Uint8Array;
    purpose: 'viewer' | 'attachments' | 'annotation-backdrop' | 'annotation-text' | 'agent';
    diagnostic?: (diagnostic: ClassicPdfDiagnostic) => void;
    progress?: () => void;
    signal?: AbortSignal;
}
interface Ownership {
    health: ClassicPdfHealth;
    connection: ClassicWorkerConnection;
    loaded: Promise<PDFDocumentProxy>;
    unwatch(): void;
    unrelay(): void;
    detachSignal(): void;
    disposal?: Promise<void>;
}
const ownership = new WeakMap<object, Ownership>();
function owned(value: object): Ownership {
    const state = ownership.get(value);
    if (!state) throw new ClassicPdfError({ code: 'message-contract-failed', incomplete: true });
    return state;
}
function assetUrl(suffix: string): string {
    const base = new URL(import.meta.env.BASE_URL, document.baseURI);
    const url = new URL(suffix, base);
    if (url.origin !== location.origin || !url.pathname.endsWith('/')) throw new Error('Classic PDF assets must be same-origin directories');
    return url.href;
}
function workerPolicy() {
    return { version: classicAssets.version, manifestHash: classicAssets.manifestHash,
        directories: Object.values(classicAssets.directories).map(assetUrl) };
}

/** A warmup failure is silent here and stays failed until a demanded open
 * exposes it and the reader explicitly retries. No font/codec is warmed. */
export function prefetchClassicPdf(): void { void readyClassicWorker(workerPolicy(), true).catch(() => {}); }
export function prepareClassicPdfRetry(force = false): void { prepareClassicWorkerRetry(force); }

/** Cancellation while waiting for shared startup cannot create an ownerless
 * late document. An open owns one real task, not a proxy per consumer. */
export async function openClassicPdf({ bytes, diagnostic, progress, signal }: ClassicPdfOpen): Promise<PDFDocumentLoadingTask> {
    const health = createClassicPdfHealth();
    let forwarded = new Set<ClassicPdfDiagnostic>();
    const unrelay = health.subscribe(() => {
        const snapshot = health.getSnapshot();
        for (const issue of snapshot) if (!forwarded.has(issue)) diagnostic?.(issue);
        forwarded = new Set(snapshot);
    });
    try {
        signal?.throwIfAborted();
        if (version !== classicAssets.version) throw new ClassicPdfError({ code: 'worker-startup-failed', incomplete: true });
        const connection = await health.guard(readyClassicWorker(workerPolicy()), signal);
        signal?.throwIfAborted();
        const task = getDocument({
            data: bytes.slice(), worker: connection.worker,
            wasmUrl: assetUrl(classicAssets.directories.wasm),
            cMapUrl: assetUrl(classicAssets.directories.cmaps),
            standardFontDataUrl: assetUrl(classicAssets.directories.standard_fonts),
            iccUrl: assetUrl(classicAssets.directories.iccs),
            cMapPacked: true, useWasm: true, enableXfa: false, stopAtErrors: true,
            maxImageSize: -1, canvasMaxAreaInBytes: -1,
        });
        // 6.1.200 has no isEvalSupported option. The pinned bundle/browser
        // gates enforce no eval/Function; no scripting/QuickJS payload ships.
        const cancel = () => { void closeClassicPdf(task).catch(() => {}); };
        const detachSignal = () => signal?.removeEventListener('abort', cancel);
        const state: Ownership = { health, connection, unrelay, detachSignal,
            unwatch: connection.subscribeDocument(task.docId, issue => health.record(issue), () => { health.progress(); progress?.(); }),
            loaded: task.promise.then(doc => { ownership.set(doc, state); return doc; }),
        };
        ownership.set(task, state);
        signal?.addEventListener('abort', cancel, { once: true });
        void state.loaded.then(detachSignal, detachSignal);
        return task;
    } catch (error) {
        recordClassicRenderFailure(health, error);
        unrelay();
        health.close();
        throw error;
    }
}

export function classicPdfHealth(value: PDFDocumentLoadingTask | PDFDocumentProxy): ClassicPdfHealth { return owned(value).health; }
export async function loadClassicPdf(task: PDFDocumentLoadingTask, signal?: AbortSignal): Promise<PDFDocumentProxy> {
    const state = owned(task);
    try { return await state.health.guard(state.loaded, signal); }
    catch (error) { recordClassicRenderFailure(state.health, error); throw error; }
}

/** A dead port never acknowledges pdf.js's Terminate RPC. Start normal local
 * teardown, but don't hold the app's leases/close behind a reply that cannot
 * arrive. Retiring the native owner has already detached every port listener. */
export function closeClassicPdf(task: PDFDocumentLoadingTask, stalled = false): Promise<void> {
    const state = owned(task);
    if (state.disposal) return state.disposal;
    const unresponsive = stalled || state.health.stalled;
    state.detachSignal();
    state.unwatch();
    if (unresponsive) state.connection.discardIfAbandoned();
    state.unrelay();
    state.health.close();
    const destruction = task.destroy();
    void destruction.catch(() => {});
    // This is after an explicit close, not a rendering deadline. Normally
    // Terminate replies immediately and the warm worker is retained. If no
    // document uses a port that never replies, release that abandoned port.
    const cleanupTimer = setTimeout(() => state.connection.discardIfAbandoned(), CLASSIC_PDF_PROGRESS_NOTICE_MS);
    state.disposal = Promise.race([destruction, state.connection.stopped]).finally(() => clearTimeout(cleanupTimer));
    return state.disposal;
}
