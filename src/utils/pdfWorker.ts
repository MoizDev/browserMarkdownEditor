// The app owns a native port. This PDFWorker constructor bypasses pdf.js's
// fake-worker path; its promise resolves immediately, so our own transferable
// ready/test handshake must finish before any document is handed that port.
import { PDFWorker } from 'pdfjs-dist';
import { ClassicPdfError } from './pdfClassicHealth';
import type { ClassicPdfDiagnostic } from './pdfClassicHealth';

type DiagnosticListener = (diagnostic: ClassicPdfDiagnostic) => void;
export interface ClassicWorkerPolicy {
    version: string;
    manifestHash: string;
    directories: readonly string[];
}
export interface ClassicWorkerConnection {
    readonly worker: PDFWorker;
    /** Resolves when the native port can no longer answer a teardown RPC. */
    readonly stopped: Promise<void>;
    subscribeDocument(id: string, listener: DiagnosticListener): () => void;
}
interface Owner {
    native: Worker;
    ready: Promise<ClassicWorkerConnection>;
    wrapper?: PDFWorker;
    failure?: ClassicPdfError;
    tainted: boolean;
    retire(): void;
}
let shared: Owner | undefined;
let constructionFailure: ClassicPdfError | undefined;
const startupError = () => new ClassicPdfError({ code: 'worker-startup-failed', incomplete: true });
// 6.1.200's generated declaration infers port:null from its default, although
// the audited constructor explicitly accepts a supplied Worker port.
const NativePortPdfWorker = PDFWorker as unknown as new (options: { port: Worker }) => PDFWorker;

function start(policy: ClassicWorkerPolicy): Owner {
    const native = new Worker(new URL('./pdfClassic.worker.ts', import.meta.url), { type: 'module' });
    const lifetime = new AbortController();
    // pdf.js attaches a handler per document using a private AbortController.
    // A dead port never answers Terminate, so those controllers never abort.
    // Attach our lifetime as well: retiring the app-owned native port detaches
    // EVERY handler without replacing a loading-task method or a message.
    const add = native.addEventListener.bind(native);
    native.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        const config = typeof options === 'boolean' ? { capture: options } : options ?? {};
        const signal = config.signal ? AbortSignal.any([config.signal, lifetime.signal]) : lifetime.signal;
        add(type, listener, { ...config, signal });
    }) as Worker['addEventListener'];

    const documents = new Map<string, DiagnosticListener>();
    let resolve!: (connection: ClassicWorkerConnection) => void;
    let reject!: (error: ClassicPdfError) => void;
    let stop!: () => void;
    const stopped = new Promise<void>(done => { stop = done; });
    const ready = new Promise<ClassicWorkerConnection>((yes, no) => { resolve = yes; reject = no; });
    let runtimeReady = false, tested = false, sentTest = false, settled = false;
    const timer = setTimeout(() => fail(), 5000);
    const notify = (diagnostic: ClassicPdfDiagnostic) => { for (const listener of [...documents.values()]) listener(diagnostic); };
    const owner: Owner = { native, ready, tainted: false, retire() { fail(); } };
    function fail() {
        if (owner.failure) return;
        owner.failure = new ClassicPdfError({ code: settled ? 'worker-failed' : 'worker-startup-failed', incomplete: true });
        clearTimeout(timer);
        reject(owner.failure);
        notify(owner.failure.diagnostic);
        documents.clear();
        lifetime.abort();
        owner.wrapper?.destroy();
        native.terminate();
        stop();
    }
    function finish() {
        if (settled || owner.failure || !runtimeReady || !tested) return;
        try {
            const worker = new NativePortPdfWorker({ port: native });
            owner.wrapper = worker;
            settled = true;
            clearTimeout(timer);
            resolve({ worker, stopped, subscribeDocument(id, listener) {
                if (owner.failure) { listener(owner.failure.diagnostic); return () => {}; }
                documents.set(id, listener);
                return () => { documents.delete(id); };
            } });
        } catch { fail(); }
    }
    function message({ data }: MessageEvent) {
        if (!data || typeof data !== 'object') return;
        if (data.sourceName === 'classic-runtime' && data.targetName === 'classic-host') {
            if (data.action === 'runtime-ready') {
                if (data.data?.version !== policy.version || data.data?.manifestHash !== policy.manifestHash) { fail(); return; }
                runtimeReady = true;
                finish();
            } else if (data.action === 'runtime-startup-failed') fail();
            else if (data.action === 'asset-load-failed') {
                owner.tainted = true;
                // A complete JS fallback is still complete. The document keeps
                // this diagnostic, but only null images/render errors warn.
                notify({ code: 'asset-load-failed', incomplete: false });
            }
            return;
        }
        if (data.targetName === 'main' && !settled) {
            if (data.action === 'ready' && !sentTest) {
                sentTest = true;
                const probe = new Uint8Array(1);
                try {
                    native.postMessage({ sourceName: 'main', targetName: 'worker', action: 'test', data: probe }, [probe.buffer]);
                    if (probe.buffer.byteLength !== 0) fail();
                } catch { fail(); }
            } else if (data.action === 'test') {
                if (data.data !== true) { fail(); return; }
                tested = true;
                finish();
            }
            return;
        }
        if (!['obj', 'commonobj'].includes(data.action)) return;
        const listener = documents.get(data.targetName);
        if (!listener) {
            if (typeof data.targetName !== 'string') notify({ code: 'message-contract-failed', incomplete: true });
            return; // A closed document can have an already-queued image reply.
        }
        const payload: unknown = data.data;
        if (!Array.isArray(payload)) { listener({ code: 'message-contract-failed', incomplete: true }); return; }
        const common = data.action === 'commonobj';
        const type = payload[common ? 1 : 2];
        if (type !== 'Image') {
            const allowed = common ? ['Font', 'FontPath', 'Pattern', 'CopyLocalImage'] : ['Pattern'];
            if (!allowed.includes(type)) listener({ code: 'message-contract-failed', incomplete: true });
            return;
        }
        const pageIndex = common ? undefined : payload[1];
        const image = payload[common ? 2 : 3];
        const valid = payload.length === (common ? 3 : 4) && typeof payload[0] === 'string'
            && (common || Number.isInteger(pageIndex) && pageIndex >= 0)
            && (image === null || typeof image === 'object' && Number.isInteger(image.width) && Number.isInteger(image.height));
        if (!valid) listener({ code: 'message-contract-failed', incomplete: true });
        else if (image === null) listener({ code: 'image-decode-failed', pageIndex, incomplete: true });
    }
    // A valid image is not a diagnostic. Keep this observer separate from the
    // library's handler; no payload is changed, consumed or synthesized.
    native.addEventListener('message', message);
    native.addEventListener('error', fail);
    native.addEventListener('messageerror', fail);
    try { native.postMessage({ sourceName: 'classic-host', targetName: 'classic-runtime', action: 'init', data: policy }); }
    catch { fail(); }
    void ready.catch(() => {});
    return owner;
}

export function readyClassicWorker(policy: ClassicWorkerPolicy, prefetch = false): Promise<ClassicWorkerConnection> {
    if (constructionFailure) return Promise.reject(constructionFailure);
    // No replacement while an existing page is trying its JS fallback. A new
    // demanded open (or explicit Retry) retires the tainted port first.
    if (shared?.tainted && !prefetch) { shared.retire(); shared = undefined; }
    try { shared ??= start(policy); }
    catch { constructionFailure = startupError(); return Promise.reject(constructionFailure); }
    return shared.failure ? Promise.reject(shared.failure) : shared.ready;
}

export function prepareClassicWorkerRetry(): void {
    constructionFailure = undefined;
    if (!shared?.failure && !shared?.tainted) return;
    shared.retire();
    shared = undefined;
}

/** Temporary compatibility for the pending core/whiteboard seams. A legacy
 * caller may use an already-ready native port, never enter fake-worker setup. */
export function pdfWorker(): PDFWorker {
    if (!shared?.wrapper || shared.failure) throw startupError();
    return shared.wrapper;
}
