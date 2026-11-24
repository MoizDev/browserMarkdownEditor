import { answeredGone, classifyMissingFile, fileGone, fileUnreachable, type ChunkLoadError } from '../chunkLoad';
import { SELF_CONTAINED_WORKER } from './scriptMarker';

// Where every worker the app starts gets its script — the clients through `createWorkerClient` and the few raw ones.
//
// Why, measured in the pinned Chrome for Testing on a production build whose host serves only the newest deployment
// (after a deploy every content-hashed file of the previous build answers 404):
// - A worker is started again and again in normal use: a board's extra geometry workers end after 5 s idle, a hidden
//   board's picture decoder ends, every file fingerprint is a worker of its own, PDF writing starts on the first save.
//   Each `new Worker(url)` after a deploy failed, in a tab that had been working: a drawing holding a picture stopped
//   saving ("File fingerprint worker failed. Your next change tries again", on every change), PDF Annotate stopped
//   saving ("Worker failed before its hello"), a dropped picture could not be shown, an open book broke when shown again.
// - So a script the bundler saw import nothing is fetched ONCE, when the code that starts it loads, and every copy of
//   that worker starts from those bytes through a Blob URL: the same code as the first copy, no network after it, and
//   no mix of versions (the URL is content-hashed: its bytes are this build's). One copy per script for the page's life,
//   never one per worker (measured: 8 scripts, 0.65 MB in all — 0.46 MB of it the PDF builder — with a drawing, a
//   notebook, a PDF in Annotate and a book open), fetched only by vaults whose documents load the code that needs it.
// - Only a script build/selfContainedWorkers.ts marked is kept: a relative import or `import.meta.url` cannot resolve
//   against a blob: URL. The others (the board parser and exporter, the vault index) start from the network as before.
// - A script that cannot be fetched says why from the server's own answer (chunkLoad.ts): a 404/410 or a page in its
//   place is `gone` — only a reload helps, and the update notice appears at once — anything else `unreachable`. A worker
//   started from the network that fails before it speaks fires a bare `error` Event with no URL (measured: a 404, an
//   import that 404s and an HTML answer look alike; an exception thrown at start is an ErrorEvent), so its URL is
//   remembered here, and `startFailure` asks the server about it.

type Script = { kind: 'kept'; url: string } | { kind: 'network' };

const FETCH_MS = 15_000;
const scripts = new Map<string, Promise<Script>>();
const networkStarted = new WeakMap<object, string>();

function fetchScript(url: string): Promise<Script> {
    const known = scripts.get(url);
    if (known) return known;
    const pending = (async (): Promise<Script> => {
        // A dev server serves each worker as a module with imports: there is nothing to keep.
        if (!import.meta.env.PROD) return { kind: 'network' };
        const href = new URL(url, location.href).href;
        let response: Response;
        try { response = await fetch(href, { signal: AbortSignal.timeout(FETCH_MS) }); }
        catch (error) {
            throw fileUnreachable(href, error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'unreachable', error);
        }
        if (answeredGone(response)) throw fileGone(href);
        if (!response.ok) throw fileUnreachable(href, 'unreachable', new Error(`HTTP ${response.status}`));
        let text: string;
        try { text = await response.text(); } catch (error) { throw fileUnreachable(href, 'unreachable', error); }
        if (!text.startsWith(SELF_CONTAINED_WORKER)) {
            console.warn(`${href} is no longer self-contained: its workers start from the network, and stop starting once a newer version replaces this one.`);
            return { kind: 'network' };
        }
        // Named after the file it came from, so a stack trace still says which worker it was.
        const blob = new Blob([text, `\n//# sourceURL=${href}\n`], { type: 'text/javascript' });
        return { kind: 'kept', url: URL.createObjectURL(blob) };
    })();
    scripts.set(url, pending);
    // A failed fetch is not remembered: the next start asks again (a dropped request recovers, a gone file stays gone).
    pending.catch(() => { if (scripts.get(url) === pending) scripts.delete(url); });
    return pending;
}

function whenIdle(run: () => void): void {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
}

export interface WorkerScript {
    /** Start one worker from this script. Rejects with a `ChunkLoadError` when the script could not be fetched. */
    start(options?: WorkerOptions): Promise<Worker>;
}

/**
 * One worker script, declared beside the code that starts it, from a `?worker&url` import (Vite builds the worker and
 * gives its URL). `keep` says the worker imports nothing, so its bytes are fetched at the next idle moment and every
 * copy starts from them; without it each start fetches the script from the network.
 */
export function workerScript(url: string, { keep }: { keep: boolean }): WorkerScript {
    if (keep && import.meta.env.PROD) whenIdle(() => { void fetchScript(url).catch(() => {}); });
    return {
        async start(options = { type: 'module' }) {
            const script = keep ? await fetchScript(url) : { kind: 'network' } as const;
            if (script.kind === 'kept') return new Worker(script.url, options);
            const worker = new Worker(url, options);
            networkStarted.set(worker, new URL(url, location.href).href);
            return worker;
        },
    };
}

/** Why a worker failed before it answered: a `ChunkLoadError` when its script came from the network and could not be
 *  loaded (gone from the server, or unreachable), or null for a worker of its own failure (an exception at start). */
export async function startFailure(worker: object, event: Event): Promise<ChunkLoadError | null> {
    const url = networkStarted.get(worker);
    if (!url || event instanceof ErrorEvent) return null;
    return classifyMissingFile(url, event);
}
