import { answeredGone, classifyMissingFile, fileGone, fileUnreachable, type ChunkLoadError } from '../chunkLoad';
import { SELF_CONTAINED_WORKER, SELF_CONTAINED_WORKER_END } from './scriptMarker';

type Script = { kind: 'kept'; url: string } | { kind: 'network' };

const FETCH_MS = 15_000;
const scripts = new Map<string, Promise<Script>>();
const networkOnly = new Set<string>();
let blobRefused = false;
const started = new WeakMap<object, { script: string; href: string; blob?: string }>();
const inWorker = typeof window === 'undefined';

function fetchScript(url: string): Promise<Script> {
    const known = scripts.get(url);
    if (known) return known;
    const pending = (async (): Promise<Script> => {
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
        if (!text.trimEnd().endsWith(SELF_CONTAINED_WORKER_END)) throw fileUnreachable(href, 'unreachable', new Error('The worker script arrived cut short'));
        const blob = new Blob([text, `\n//# sourceURL=${href}\n`], { type: 'text/javascript' });
        return { kind: 'kept', url: URL.createObjectURL(blob) };
    })();
    scripts.set(url, pending);
    pending.catch(() => { if (scripts.get(url) === pending) scripts.delete(url); });
    return pending;
}

function whenIdle(run: () => void): void {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
}

export interface WorkerScript {
    start(options?: WorkerOptions): Promise<Worker>;
}

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

function notLoaded(event: Event): boolean {
    return !(event instanceof ErrorEvent) || /SyntaxError/.test(event.message);
}

export function dropKeptCopy(worker: object, event: Event): boolean {
    const start = started.get(worker);
    if (!start?.blob || networkOnly.has(start.script) || !notLoaded(event)) return false;
    if (!(event instanceof ErrorEvent)) blobRefused = true;
    networkOnly.add(start.script);
    void scripts.get(start.script)?.then(script => { if (script.kind === 'kept' && script.url === start.blob) scripts.delete(start.script); }, () => {});
    URL.revokeObjectURL(start.blob);
    return true;
}

export async function startFailure(worker: object, event: Event): Promise<ChunkLoadError | null> {
    const start = started.get(worker);
    if (!start) return null;
    if (!notLoaded(event)) return null;
    if (start.blob) { dropKeptCopy(worker, event); return fileUnreachable(start.href, 'unreachable', event); }
    if (event instanceof ErrorEvent) return null;
    return classifyMissingFile(start.href, event);
}

export function helloTimedOut(worker: object): ChunkLoadError | null {
    const start = started.get(worker);
    return start && !start.blob ? fileUnreachable(start.href, 'timeout', new Error('No hello in time')) : null;
}
