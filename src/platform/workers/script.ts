import { answeredGone, classifyMissingFile, fileGone, fileUnreachable, type ChunkLoadError } from '../chunkLoad';
import { SELF_CONTAINED_WORKER, SELF_CONTAINED_WORKER_END } from './scriptMarker';

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
/** Scripts whose kept copy would not start: every later copy starts from the network, exactly as before kept copies.
 *  Measured with a script whose answer was cut short: kept for good, the worker could not start again until a reload,
 *  and the person's Retry never worked. A browser policy or extension that refuses blob workers lands here too. */
const networkOnly = new Set<string>();
/** Blob workers are refused on this page (a browser policy or an extension): a kept copy failed to load, or creating one
 *  threw. From then on every script starts from the network — exactly the behaviour from before kept copies. */
let blobRefused = false;
/** Each started worker's script, and the Blob URL it started from when it was a kept copy. */
const started = new WeakMap<object, { script: string; href: string; blob?: string }>();
const inWorker = typeof window === 'undefined';

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
        // The one check worth its cost: a body cut short (a dropped connection a server still answered 200 for, with a
        // length to match) still starts with the mark but has lost the end one. Not kept, and not remembered: the next
        // start fetches again. A hash of the whole file would add little over TLS's own integrity, and a copy damaged in
        // some other way is caught when it fails to start (`startFailure`), after which the script starts from the network.
        // (The bundle ends the file with a newline after the mark, so trailing whitespace is not part of the check.)
        if (!text.trimEnd().endsWith(SELF_CONTAINED_WORKER_END)) throw fileUnreachable(href, 'unreachable', new Error('The worker script arrived cut short'));
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
 * gives its URL). `keep` says the worker imports nothing, so its bytes are fetched once and every copy starts from them;
 * without it each start fetches the script from the network.
 *
 * On the page itself a kept script is fetched at the next idle moment after its code loads, because that is what lets a
 * document opened before a deploy start its next worker after it. Inside a worker (the vault index bundles the agent
 * matcher's client; the board parser bundles the board workers' clients) it is fetched by its first start instead: the
 * idle fetch there cost every page load a download of scripts those workers seldom or never start (measured: the index
 * worker fetched the matcher once per page load).
 */
export function workerScript(url: string, { keep }: { keep: boolean }): WorkerScript {
    if (keep && import.meta.env.PROD && !inWorker) whenIdle(() => { void fetchScript(url).catch(() => {}); });
    return {
        async start(options = { type: 'module' }) {
            const script = keep && !blobRefused && !networkOnly.has(url) ? await fetchScript(url) : { kind: 'network' } as const;
            const href = new URL(url, location.href).href;
            if (script.kind === 'kept' && !blobRefused) {
                try {
                    const worker = new Worker(script.url, options);
                    started.set(worker, { script: url, href, blob: script.url });
                    return worker;
                } catch (error) {
                    blobRefused = true;
                    console.warn('Blob workers are refused here; every worker now starts from the network:', error);
                }
            }
            const worker = new Worker(url, options);
            started.set(worker, { script: url, href });
            return worker;
        },
    };
}

/** The error a worker fired says its script did not load or parse — not an exception its own code threw once running
 *  (an ErrorEvent other than a SyntaxError), which a fresh copy of the same bytes would throw again. */
function notLoaded(event: Event): boolean {
    return !(event instanceof ErrorEvent) || /SyntaxError/.test(event.message);
}

/**
 * A worker started from a kept copy failed to load before it answered: drop that copy (its Blob URL is revoked; workers
 * already running from it are unaffected), so this script's next start, and every later one, goes to the network. True
 * when a copy was dropped — the caller may start again at once, and that start is the old behaviour exactly.
 */
export function dropKeptCopy(worker: object, event: Event): boolean {
    const start = started.get(worker);
    if (!start?.blob || networkOnly.has(start.script) || !notLoaded(event)) return false;
    // A copy that would not even load (a bare error event) is blob workers being refused, which holds for every script;
    // one that would not parse (a SyntaxError) is this script's bytes, and only it goes back to the network.
    if (!(event instanceof ErrorEvent)) blobRefused = true;
    networkOnly.add(start.script);
    void scripts.get(start.script)?.then(script => { if (script.kind === 'kept' && script.url === start.blob) scripts.delete(start.script); }, () => {});
    URL.revokeObjectURL(start.blob);
    return true;
}

/** Why a worker failed before it answered, said in the person's words: a `ChunkLoadError` for a script that could not be
 *  loaded (gone from the server, unreachable, or a kept copy that would not run — dropped here, so Retry starts it from
 *  the network), or null for a worker of its own failure (an exception thrown by a script that did arrive). */
export async function startFailure(worker: object, event: Event): Promise<ChunkLoadError | null> {
    const start = started.get(worker);
    if (!start) return null;
    if (!notLoaded(event)) return null;
    if (start.blob) { dropKeptCopy(worker, event); return fileUnreachable(start.href, 'unreachable', event); }
    if (event instanceof ErrorEvent) return null;
    return classifyMissingFile(start.href, event);
}

/** A worker that never said hello: when its script came from the network, the script did not arrive in time (a worker
 *  says hello as its module first runs, platform/workers/serve.ts) — said as a download that is taking too long. */
export function helloTimedOut(worker: object): ChunkLoadError | null {
    const start = started.get(worker);
    return start && !start.blob ? fileUnreachable(start.href, 'timeout', new Error('No hello in time')) : null;
}
