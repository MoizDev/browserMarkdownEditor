export type ClassicPdfFailureCode = 'image-decode-failed' | 'asset-load-failed' | 'worker-startup-failed' | 'worker-failed' | 'message-contract-failed' | 'render-failed' | 'render-delayed';
export interface ClassicPdfDiagnostic {
    code: ClassicPdfFailureCode;
    pageIndex?: number;
    /** A failed dependency can have a complete JS fallback. Record the fault,
     * but never tell the reader a fully painted page is incomplete. */
    incomplete: boolean;
}
export interface ClassicPdfHealth {
    getSnapshot(): readonly ClassicPdfDiagnostic[];
    subscribe(listener: () => void): () => void;
    record(diagnostic: ClassicPdfDiagnostic): void;
    guard<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T>;
    assertComplete(pageIndex?: number): void;
    progress(): void;
    close(): void;
    readonly closed: boolean;
    readonly stalled: boolean;
}
// A progress notice, never a decode deadline: large scans keep running. The
// clock is reset by native document messages, not by a guessed image size.
export const CLASSIC_PDF_PROGRESS_NOTICE_MS = 10_000;
const EMPTY: readonly ClassicPdfDiagnostic[] = Object.freeze([]);
const cancelled = () => new DOMException('PDF operation cancelled', 'AbortError');
export const classicPdfFailureIsFatal = (diagnostic: ClassicPdfDiagnostic) => diagnostic.incomplete && ['worker-startup-failed', 'worker-failed', 'message-contract-failed'].includes(diagnostic.code);

export class ClassicPdfError extends Error {
    constructor(readonly diagnostic: ClassicPdfDiagnostic) {
        super(diagnostic.code === 'worker-startup-failed' ? 'The PDF renderer could not start.'
            : diagnostic.code === 'worker-failed' ? 'The PDF renderer stopped.'
            : 'This PDF could not be rendered completely.');
        this.name = 'ClassicPdfError';
    }
}

/** A document's sticky render verdict, not a whiteness heuristic. A genuinely
 * blank page is complete unless a typed renderer failure says otherwise. */
export function createClassicPdfHealth(): ClassicPdfHealth {
    let snapshot = EMPTY;
    let closed = false, stalled = false, operations = 0;
    let lastProgress = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<() => void>();
    const publish = () => { for (const listener of [...listeners]) listener(); };
    function clearDelay() {
        stalled = false;
        if (!snapshot.some(issue => issue.code === 'render-delayed')) return;
        snapshot = Object.freeze(snapshot.filter(issue => issue.code !== 'render-delayed'));
        publish();
    }
    function armTimer() {
        if (closed || !operations || timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            if (closed || !operations) return;
            if (performance.now() - lastProgress < CLASSIC_PDF_PROGRESS_NOTICE_MS) { armTimer(); return; }
            health.record({ code: 'render-delayed', incomplete: false });
        }, Math.max(1, CLASSIC_PDF_PROGRESS_NOTICE_MS - (performance.now() - lastProgress)));
    }
    function beginOperation() {
        if (++operations === 1) lastProgress = performance.now();
        armTimer();
        let held = true;
        return () => {
            if (!held) return;
            held = false;
            if (--operations !== 0) return;
            clearTimeout(timer); timer = undefined;
            if (!closed) clearDelay();
        };
    }
    const health: ClassicPdfHealth = {
        get closed() { return closed; },
        get stalled() { return stalled; },
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        record(diagnostic) {
            if (closed) return;
            if (diagnostic.code === 'render-delayed') stalled = true;
            if (snapshot.some(previous => previous.code === diagnostic.code && previous.pageIndex === diagnostic.pageIndex && previous.incomplete === diagnostic.incomplete)) return;
            snapshot = Object.freeze([...snapshot, Object.freeze({ ...diagnostic })]);
            publish();
        },
        guard<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
            const pending = Promise.resolve(operation);
            return new Promise<T>((resolve, reject) => {
                let finished = false;
                const releaseOperation = beginOperation();
                const stop = (error: unknown) => { if (finished) return; finished = true; cleanup(); reject(error); };
                const check = () => {
                    if (closed || signal?.aborted) { stop(cancelled()); return; }
                    const failure = snapshot.find(classicPdfFailureIsFatal);
                    if (failure) stop(new ClassicPdfError(failure));
                };
                const cleanup = () => { listeners.delete(check); signal?.removeEventListener('abort', check); releaseOperation(); };
                listeners.add(check);
                signal?.addEventListener('abort', check, { once: true });
                check();
                pending.then(value => {
                    check();
                    if (finished) return;
                    finished = true;
                    cleanup();
                    resolve(value);
                }, stop);
            });
        },
        assertComplete(pageIndex) {
            if (closed) throw cancelled();
            const failure = snapshot.find(diagnostic => diagnostic.incomplete && (pageIndex === undefined || diagnostic.pageIndex === undefined || diagnostic.pageIndex === pageIndex));
            if (failure) throw new ClassicPdfError(failure);
        },
        progress() {
            if (closed) return;
            lastProgress = performance.now();
            if (stalled) clearDelay();
            armTimer();
        },
        close() {
            if (closed) return;
            closed = true;
            clearTimeout(timer); timer = undefined;
            publish();
            listeners.clear();
        },
    };
    return health;
}

export function isClassicPdfCancellation(error: unknown): boolean {
    return error instanceof Error && ['AbortError', 'AbortException', 'RenderingCancelledException'].includes(error.name);
}
export function recordClassicRenderFailure(health: ClassicPdfHealth, error: unknown, pageIndex?: number): void {
    if (isClassicPdfCancellation(error)) return;
    health.record(error instanceof ClassicPdfError ? error.diagnostic : { code: 'render-failed', pageIndex, incomplete: true });
}

// The annotation source is opened inside the whiteboard host, but its owning
// PdfPane must show a warning without remounting that host (and losing ink).
const annotationHealth = new WeakMap<Uint8Array, ClassicPdfHealth>();
export function classicAnnotationHealth(bytes: Uint8Array): ClassicPdfHealth {
    let health = annotationHealth.get(bytes);
    if (!health || health.closed) { health = createClassicPdfHealth(); annotationHealth.set(bytes, health); }
    return health;
}
