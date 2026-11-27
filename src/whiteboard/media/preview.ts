import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ClipboardHtmlFrameHost } from '../clipboard/htmlFrameHost';
import { checkContentUrl, type UrlEnvironment } from '../security/urlPolicy';
import { SECURITY_LIMITS } from '../security/limits';

export interface LinkPreviewResult { readonly title: string; readonly description: string; readonly image: string; readonly icon: string; readonly page: string }
export async function fetchLinkPreview(options: {
    readonly url: string;
    readonly environment: UrlEnvironment;
    readonly memory: MemoryAllocator;
    readonly frame: Pick<ClipboardHtmlFrameHost, 'metadata'>;
    readonly signal?: AbortSignal;
    current(): boolean;
}): Promise<LinkPreviewResult> {
    const decision = checkContentUrl(options.url, 'preview', options.environment);
    if (!decision.ok) throw new Error(decision.reason);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    const check = () => { signal.throwIfAborted(); if (!options.current()) throw new DOMException('Preview became stale', 'AbortError'); };
    check();
    const lease = options.memory.reserve(SECURITY_LIMITS.previewBytes * 6);
    if (!lease) throw new Error('Insufficient memory for link preview');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const response = await fetch(decision.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
            redirect: 'error', cache: 'no-store', signal });
        check();
        if (!response.ok || !response.body) throw new Error('Preview response is unavailable');
        const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') throw new Error('Preview response is not HTML');
        const declared = response.headers.get('content-length');
        if (declared !== null && /^\d+$/.test(declared) && Number(declared) > SECURITY_LIMITS.previewBytes) throw new RangeError('Preview response exceeds its limit');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true }), chunks: string[] = [];
        let bytes = 0;
        for (;;) {
            const chunk = await reader.read(); check();
            if (chunk.done) break;
            if (chunk.value.byteLength > SECURITY_LIMITS.previewBytes - bytes) throw new RangeError('Preview response exceeds its limit');
            bytes += chunk.value.byteLength; chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        const metadata = await options.frame.metadata(chunks.join(''), signal); check();
        return Object.freeze({ title: metadata.title, description: metadata.description, image: metadata.image, icon: metadata.icon, page: decision.url });
    } finally {
        if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        options.memory.release(lease);
    }
}
