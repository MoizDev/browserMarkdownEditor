// The running JS carries its own build id; using the first fetched version as
// a baseline would miss a deployment that finished before the first poll.
const POLL_INTERVAL = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 15_000;

export function watchForNewVersion(onUpdate: () => void): () => void {
    if (!import.meta.env.PROD) return () => {};
    let stopped = false;
    let found = false;
    let request: AbortController | undefined;
    const poll = async () => {
        if (stopped || found || request || document.visibilityState !== 'visible') return;
        const controller = new AbortController();
        request = controller;
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            const url = new URL(`${import.meta.env.BASE_URL}version.json`, window.location.href);
            url.searchParams.set('check', String(Date.now()));
            const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) return;
            const data: unknown = await response.json();
            if (!stopped && data && typeof data === 'object' && 'version' in data
                && typeof data.version === 'string' && data.version.length > 0 && data.version !== __BME_BUILD_ID__) {
                found = true;
                onUpdate();
            }
        } catch { /* Offline and partial deployments are retried on the next poll. */ }
        finally {
            clearTimeout(timeout);
            if (request === controller) request = undefined;
        }
    };
    const visible = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    const timer = setInterval(() => { void poll(); }, POLL_INTERVAL);
    void poll();
    return () => {
        stopped = true;
        clearInterval(timer);
        request?.abort();
        document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('online', visible);
    };
}
