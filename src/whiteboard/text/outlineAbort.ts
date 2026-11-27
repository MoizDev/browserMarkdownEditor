export function awaitOutlineResource<T>(work: Promise<T>, signal: AbortSignal, timeoutMs?: number, label = 'Export resource'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (success: boolean, value: T | unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            if (timer !== undefined) clearTimeout(timer);
            if (success) resolve(value as T); else reject(value);
        };
        const abort = () => finish(false, signal.reason ?? new DOMException('Text export cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (timeoutMs !== undefined) timer = setTimeout(() => finish(false, new DOMException(`${label} deadline exceeded`, 'TimeoutError')), timeoutMs);
        work.then(value => finish(true, value), error => finish(false, error));
        if (signal.aborted) abort();
    });
}
