/** Network traffic observed by the driver, not an in-app fetch monkey patch.
 * @param {import('playwright').Page} page
 */
export function recordRequests(page) {
    const context = page.context(), records = [], byRequest = new WeakMap(), pending = new Set();
    const request = req => {
        const url = req.url();
        const row = { url, origin: new URL(url).origin, method: req.method(), resourceType: req.resourceType(),
            status: null, transferSize: null, failure: null };
        records.push(row); byRequest.set(req, row);
    };
    const response = res => {
        const row = byRequest.get(res.request());
        if (row) { row.status = res.status(); row.fromServiceWorker = res.fromServiceWorker(); }
    };
    const finished = req => {
        const task = (async () => {
            const row = byRequest.get(req);
            if (!row) return;
            try {
                const size = await req.sizes();
                row.transferSize = size.responseHeadersSize + size.responseBodySize;
                row.sizes = size;
            } catch (error) { row.sizeError = error.message; }
        })();
        pending.add(task);
        task.finally(() => pending.delete(task));
    };
    const failed = req => { const row = byRequest.get(req); if (row) row.failure = req.failure()?.errorText ?? 'failed'; };
    context.on('request', request); context.on('response', response);
    context.on('requestfinished', finished); context.on('requestfailed', failed);
    return {
        async read() { await Promise.all([...pending]); return structuredClone(records); },
        stop() {
            context.off('request', request); context.off('response', response);
            context.off('requestfinished', finished); context.off('requestfailed', failed);
        },
    };
}
