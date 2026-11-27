const ATTEMPT_MS = 15_000;
const RETRY_DELAY_MS = 400;

export type ChunkFailure = 'gone' | 'unreachable' | 'timeout';

export class ChunkLoadError extends Error {
    readonly failure: ChunkFailure;
    readonly url: string | undefined;
    constructor(failure: ChunkFailure, url: string | undefined, cause: unknown) {
        super(failure === 'gone' ? 'This part of the app was replaced by a newer version.'
            : failure === 'timeout' ? 'This part of the app is taking too long to download.'
                : 'This part of the app could not be downloaded.', { cause });
        this.name = 'ChunkLoadError';
        this.failure = failure;
        this.url = url;
    }
}

export function isChunkLoadError(error: unknown): error is ChunkLoadError {
    return error instanceof ChunkLoadError;
}

export function chunkFailureOf(error: unknown): ChunkLoadError | null {
    for (let link = error, depth = 0; link && depth < 8; depth++) {
        if (link instanceof ChunkLoadError) return link;
        link = link instanceof Error ? link.cause : undefined;
    }
    return null;
}

export function isAppReplaced(error: unknown): boolean {
    return chunkFailureOf(error)?.failure === 'gone';
}

const goneListeners = new Set<(url: string | undefined) => void>();
const failureListeners = new Set<() => void>();
let goneSeen = false;

export function subscribeChunkFailure(listener: () => void): () => void {
    failureListeners.add(listener);
    return () => { failureListeners.delete(listener); };
}

function announceFailure(): void {
    for (const listener of [...failureListeners]) {
        try { listener(); } catch (error) { console.error('Chunk-failure subscriber failed:', error); }
    }
}

export function subscribeChunkGone(listener: (url: string | undefined) => void): () => void {
    goneListeners.add(listener);
    if (goneSeen) queueMicrotask(() => { if (goneListeners.has(listener)) listener(undefined); });
    return () => { goneListeners.delete(listener); };
}

function announceGone(url: string | undefined): void {
    goneSeen = true;
    for (const listener of [...goneListeners]) {
        try { listener(url); } catch (error) { console.error('Chunk-gone subscriber failed:', error); }
    }
}

const LOAD_FAILURE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Expected a JavaScript(?:-or-Wasm)? module script/i;
const ANSWERED_WITH_PAGE = /MIME type of "?text\/html/i;

function failedUrl(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const match = /(https?:\/\/\S+|\/\S+\.(?:js|css|mjs))/.exec(message);
    return match ? match[1].replace(/[),.]+$/, '') : undefined;
}

function isLoadFailure(error: unknown): boolean {
    return error instanceof Error && LOAD_FAILURE.test(error.message);
}

export function answeredGone(response: Response): boolean {
    return response.status === 404 || response.status === 410
        || (response.ok && (response.headers.get('content-type') ?? '').includes('text/html'));
}

async function isGone(url: string | undefined): Promise<boolean> {
    if (!url) return false;
    try {
        const target = new URL(url, location.href);
        if (target.origin !== location.origin) return false;
        return answeredGone(await fetch(target, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(5000) }));
    } catch { return false; }
}

export async function classifyMissingFile(url: string, cause: unknown): Promise<ChunkLoadError> {
    announceFailure();
    if (await isGone(url)) return fileGone(url, cause);
    return new ChunkLoadError('unreachable', url, cause);
}

export function fileGone(url: string, cause?: unknown): ChunkLoadError {
    announceGone(url);
    return new ChunkLoadError('gone', url, cause);
}

export function fileUnreachable(url: string, failure: 'unreachable' | 'timeout', cause?: unknown): ChunkLoadError {
    announceFailure();
    return new ChunkLoadError(failure, url, cause);
}

export async function classifyChunkFailure(error: unknown): Promise<ChunkLoadError | null> {
    if (error instanceof ChunkLoadError) return error;
    if (!isLoadFailure(error)) return null;
    announceFailure();
    const url = failedUrl(error);
    if (ANSWERED_WITH_PAGE.test(error instanceof Error ? error.message : '') || await isGone(url)) {
        announceGone(url);
        return new ChunkLoadError('gone', url, error);
    }
    return new ChunkLoadError('unreachable', url, error);
}

const TIMED_OUT = Symbol('timed out');

function withDeadline<T>(attempt: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        attempt,
        new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
    ]).finally(() => clearTimeout(timer));
}

export async function loadChunk<T>(importer: () => Promise<T>, options: { attemptMs?: number } = {}): Promise<T> {
    const attemptMs = options.attemptMs ?? ATTEMPT_MS;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        let result: T | typeof TIMED_OUT;
        try {
            result = await withDeadline(importer(), attemptMs);
        } catch (error) {
            if (!isLoadFailure(error)) throw error;
            const classified = await classifyChunkFailure(error);
            if (classified?.failure === 'gone') throw classified;
            lastError = classified ?? error;
            continue;
        }
        if (result !== TIMED_OUT) return result;
        announceFailure();
        lastError = new ChunkLoadError('timeout', undefined, undefined);
    }
    throw lastError;
}

let preloadListening = false;
export function listenForPreloadErrors(): void {
    if (preloadListening) return;
    preloadListening = true;
    window.addEventListener('vite:preloadError', event => {
        void classifyChunkFailure((event as Event & { payload?: unknown }).payload);
    });
}
