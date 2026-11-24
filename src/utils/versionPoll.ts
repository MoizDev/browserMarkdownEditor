import { subscribeChunkFailure, subscribeChunkGone } from '../platform/chunkLoad';

// The running page knows its own build from index.html's `bme-build` meta tag (vite.config.ts writes it, and the same
// id into version.json); using the first fetched version as a baseline would miss a deployment that finished before
// the first poll. The id is not compiled into any chunk: that renamed a third of them on every build.
const POLL_INTERVAL = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 15_000;

function runningBuild(): string | null {
    const content = document.querySelector<HTMLMetaElement>('meta[name="bme-build"]')?.content;
    return content && content !== 'bme-build-id-slot' ? content : null;
}

export function watchForNewVersion(onUpdate: () => void): () => void {
    if (!import.meta.env.PROD) return () => {};
    const running = runningBuild();
    let stopped = false;
    let found = false;
    let request: AbortController | undefined;
    const announce = () => {
        if (stopped || found) return;
        found = true;
        onUpdate();
    };
    // A lazy chunk of this build answered 404: the deployment that served this page has been replaced, whatever
    // version.json says (or whether it exists at all), and only a reload can load what the page asks for next.
    const unsubscribeGone = subscribeChunkGone(announce);
    const poll = async () => {
        if (!running || stopped || found || request || document.visibilityState !== 'visible') return;
        const controller = new AbortController();
        request = controller;
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            const url = new URL(`${import.meta.env.BASE_URL}version.json`, window.location.href);
            url.searchParams.set('check', String(Date.now()));
            const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
            // Every build of this app emits version.json, and the host answers a missing file with a real 404: a 404
            // means the live deployment is a build from before this file existed (measured: the rollback left every
            // tab of the newer build polling a 404 forever, never told its chunks were gone).
            if (response.status === 404) { announce(); return; }
            if (!response.ok) return;
            const data: unknown = await response.json();
            if (data && typeof data === 'object' && 'version' in data
                && typeof data.version === 'string' && data.version.length > 0 && data.version !== running) announce();
        } catch { /* Offline and partial deployments are retried on the next poll. */ }
        finally {
            clearTimeout(timeout);
            if (request === controller) request = undefined;
        }
    };
    // Any other failed chunk: ask at once rather than at the next five-minute poll (measured: right after a deploy,
    // an open tab half-worked — a board read-only, the graph throwing — for up to five minutes before it was told).
    const unsubscribeFailure = subscribeChunkFailure(() => { void poll(); });
    const visible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    const timer = setInterval(() => { void poll(); }, POLL_INTERVAL);
    void poll();
    return () => {
        stopped = true;
        unsubscribeGone();
        unsubscribeFailure();
        clearInterval(timer);
        request?.abort();
        document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('online', visible);
    };
}
