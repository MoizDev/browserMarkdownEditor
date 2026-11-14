import { PdfEngineError } from '../engine/types';
import type { EngineInitArgs } from './protocol';

function integrity(hex: string): string {
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new PdfEngineError('EngineBroken', 'Invalid PDF engine integrity pin');
    return `sha256-${btoa(hex.match(/../g)!.map(byte => String.fromCharCode(parseInt(byte, 16))).join(''))}`;
}

/** C5 carries identity/URLs, not WebAssembly.Module or engine bytes. The browser
 * authenticates the response with SRI before streaming compilation inside this opaque worker. */
export async function compilePdfEngine(args: EngineInitArgs, signal?: AbortSignal): Promise<WebAssembly.Module> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        signal?.throwIfAborted();
        const url = new URL(args.wasmUrl), base = new URL(args.assetBase);
        if (!['https:', 'http:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password ||
            url.search || url.hash || !base.pathname.endsWith('/') || !url.pathname.startsWith(base.pathname) ||
            !Number.isSafeInteger(args.wasmBytes) || args.wasmBytes < 1 || args.wasmBytes > 64 * 1024 * 1024) {
            throw new Error('Invalid pinned engine URL');
        }
        const response = await fetch(url, { signal, integrity: integrity(args.artifactSha256),
            mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' });
        if (!response.ok || response.type === 'opaque' || !response.body ||
            response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/wasm') {
            throw new Error('Invalid engine response');
        }
        reader = response.body.getReader();
        const source = reader;
        let received = 0;
        const bytes = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    signal?.throwIfAborted();
                    const chunk = await source.read();
                    if (chunk.done) {
                        if (received !== args.wasmBytes) throw new Error('Engine length mismatch');
                        controller.close();
                    } else {
                        received += chunk.value.byteLength;
                        if (received > args.wasmBytes) throw new Error('Engine length mismatch');
                        controller.enqueue(chunk.value);
                    }
                } catch (error) { controller.error(error); }
            },
            cancel(reason) { return source.cancel(reason); },
        });
        const module = await WebAssembly.compileStreaming(new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }));
        signal?.throwIfAborted();
        return module;
    } catch {
        if (reader) void reader.cancel().catch(() => {});
        if (signal?.aborted) throw new PdfEngineError('AbortError', 'PDF engine startup cancelled');
        // SRI, CORS, CSP and streaming errors all fail closed. There is no unchecked/refetch path.
        throw new PdfEngineError('EngineBroken', 'PDF engine integrity or cross-origin startup failed');
    } finally { reader?.releaseLock(); }
}
