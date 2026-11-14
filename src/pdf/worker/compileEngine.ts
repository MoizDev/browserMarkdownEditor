import { PdfEngineError } from '../engine/types';
import type { EngineInitArgs } from './protocol';

/** The trusted host already authenticated the immutable WASM Blob. Its URL is
 * minted by the opaque broker; network origins remain forbidden in worker CSP. */
export async function compilePdfEngine(args: EngineInitArgs, signal?: AbortSignal): Promise<WebAssembly.Module> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        signal?.throwIfAborted();
        if (!args.engineUrl.startsWith('blob:null/') || !/^[a-f0-9]{64}$/.test(args.artifactSha256) ||
            !Number.isSafeInteger(args.wasmBytes) || args.wasmBytes < 1 || args.wasmBytes > 64 * 1024 * 1024) {
            throw new Error('Invalid pinned engine blob');
        }
        const response = await fetch(args.engineUrl, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok || !response.body || response.headers.get('Content-Type') !== 'application/wasm') {
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
        throw new PdfEngineError('EngineBroken', 'PDF engine integrity or startup failed');
    } finally { reader?.releaseLock(); }
}
