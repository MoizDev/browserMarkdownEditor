// One way to load a lazy chunk on a path a person is waiting on: bounded in time, retried once, and told apart when the
// chunk is GONE (the deployment that named it was replaced) from when it is only unreachable right now.
//
// Why each part, measured in the pinned Chrome for Testing:
// - A bare `import()` has no deadline. A request that is never answered (a stalled HTTP/2 stream, a proxy or extension
//   holding it) left a board on "Loading drawing…" or "Preparing canvas editor…" for a whole 75 s run with no error.
// - A FAILED import is fetched again by the next `import()` of the same module (measured: 404 then 200 → the second call
//   resolved), so one retry cures a dropped request. A STALLED one is joined, not re-requested (the second call waited on
//   the same pending fetch), so a stall can only be bounded; the person's own Retry joins it again, and Reload starts over.
// - The host (Vercel) serves only the newest deployment and answers a missing file with a real 404. After a redeploy
//   every lazy chunk an open tab had not loaded yet is gone, and no retry can bring it back: only a reload can, which
//   is what the update notice offers (utils/versionPoll.ts listens through `subscribeChunkGone`). A host with an SPA
//   fallback answers the same request with index.html instead (measured: "Expected a JavaScript-or-Wasm module script
//   but the server responded with a MIME type of text/html"), which is the same news.
//
// Lives in src/platform because every layer may import it (platform imports nothing app-specific). Callers pass the
// importer as a thunk so Vite still sees each literal `import()` and keeps its chunk and preload wiring.

/** How long one attempt may take before it is abandoned (the browser's own fetch is left running and joined by the
 *  retry): long enough for a multi-megabyte chunk on a slow connection, short enough that a stall surfaces in seconds. */
const ATTEMPT_MS = 15_000;
const RETRY_DELAY_MS = 400;

export type ChunkFailure = 'gone' | 'unreachable' | 'timeout';

/** A lazy chunk could not be loaded. `failure` says what a person can do about it: `gone` needs a reload (a newer
 *  version replaced this one), `unreachable` and `timeout` may work on Retry. */
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

const goneListeners = new Set<(url: string | undefined) => void>();
const failureListeners = new Set<() => void>();
let goneSeen = false;

/** Called after any chunk failed to load — a moment to ask the server at once whether a new version is live. */
export function subscribeChunkFailure(listener: () => void): () => void {
    failureListeners.add(listener);
    return () => { failureListeners.delete(listener); };
}

function announceFailure(): void {
    for (const listener of [...failureListeners]) {
        try { listener(); } catch (error) { console.error('Chunk-failure subscriber failed:', error); }
    }
}

/** Called once a chunk of this build is known to be gone from the server (and at once if one already was). */
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

// Chromium: "Failed to fetch dynamically imported module: <url>"; Vite's preload helper: "Unable to preload CSS for <url>".
const LOAD_FAILURE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Expected a JavaScript(?:-or-Wasm)? module script/i;
// The server answered a module request with a page: an SPA fallback standing in for a file that is not there.
const ANSWERED_WITH_PAGE = /MIME type of "?text\/html/i;

function failedUrl(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const match = /(https?:\/\/\S+|\/\S+\.(?:js|css|mjs))/.exec(message);
    return match ? match[1].replace(/[),.]+$/, '') : undefined;
}

function isLoadFailure(error: unknown): boolean {
    return error instanceof Error && LOAD_FAILURE.test(error.message);
}

/** Ask the server whether a chunk still exists: a 404/410 means this build's files were replaced. */
async function isGone(url: string | undefined): Promise<boolean> {
    if (!url) return false;
    try {
        const target = new URL(url, location.href);
        if (target.origin !== location.origin) return false;
        const response = await fetch(target, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(5000) });
        return response.status === 404 || response.status === 410
            || (response.ok && (response.headers.get('content-type') ?? '').includes('text/html'));
    } catch { return false; }
}

/** Classify a failed import, announcing a gone chunk. Exported for the `vite:preloadError` listener. */
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

/**
 * Load a lazy chunk: at most two attempts of `ATTEMPT_MS` each, the second only after a load failure or a timeout.
 * Rejects with `ChunkLoadError` for a chunk that could not be fetched, or with the module's own error when it was
 * fetched and threw while evaluating (a bug, not a delivery problem: retrying would only run it again).
 */
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
/** Vite dispatches `vite:preloadError` before a failed dynamic import rejects — for every import, including the ones
 *  not routed through `loadChunk` — so a gone chunk raises the update notice wherever it surfaced. The error itself is
 *  left to propagate (no preventDefault) to the caller or the nearest error boundary, which says what failed. */
export function listenForPreloadErrors(): void {
    if (preloadListening) return;
    preloadListening = true;
    window.addEventListener('vite:preloadError', event => {
        void classifyChunkFailure((event as Event & { payload?: unknown }).payload);
    });
}
