import { subscribeChunkFailure, subscribeChunkGone } from '../platform/chunkLoad';

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
