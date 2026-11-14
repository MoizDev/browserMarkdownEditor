import { getSharedPdfPool } from '../session/startup';
import type { DisplayPdfInput } from './types';
import { newPdfWriteId } from './writeIdentity';
import { typedPdfWriter } from './writerClient';

/** One immutable output identity survives retries; any caller abort cancels the shared attempt. */
export function createNativeNotebookPdfBuild(input: DisplayPdfInput, options: { readonly revision: number }) {
    const { revision } = options;
    if (!input || input.schema !== 1 || !input.notebookSource || !Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError('Native notebook export requires a captured revision and source path');
    }
    const writeId = newPdfWriteId();
    const args = structuredClone({ revision, writeId, displayListSchema: 1 as const,
        pages: [...input.pages], notebookSource: { path: input.notebookSource.path } });
    let completed: Uint8Array | undefined, pending: Promise<Uint8Array> | undefined, controller: AbortController | undefined;
    return {
        run(signal?: AbortSignal): Promise<Uint8Array> {
            if (signal?.aborted) return Promise.reject(signal.reason);
            if (completed) return Promise.resolve(completed.slice());
            if (!pending) {
                const attempt = new AbortController(); controller = attempt;
                pending = (async () => {
                    const writer = typedPdfWriter(await getSharedPdfPool().writer({ signal: attempt.signal }));
                    let bytes: Uint8Array;
                    try {
                        attempt.signal.throwIfAborted();
                        const product = await writer.request('writer.buildNotebook', args, { signal: attempt.signal, priority: 2 });
                        attempt.signal.throwIfAborted();
                        if (product.revision !== revision || product.writeId !== writeId) throw new Error('Notebook writer returned another build');
                        bytes = new Uint8Array(product.bytes);
                    } finally { await writer.close(); }
                    attempt.signal.throwIfAborted();
                    completed = bytes;
                    return bytes;
                })().finally(() => { pending = undefined; controller = undefined; });
            }
            const shared = pending, active = controller!;
            const abort = () => active.abort(signal?.reason);
            signal?.addEventListener('abort', abort, { once: true });
            return shared.then(bytes => { signal?.removeEventListener('abort', abort); signal?.throwIfAborted(); return bytes.slice(); },
                error => { signal?.removeEventListener('abort', abort); throw error; });
        },
    };
}

/** Compatibility one-shot; retrying callers must retain the factory result. */
export function buildNativeNotebookPdf(input: DisplayPdfInput,
    options: { readonly revision: number; readonly signal?: AbortSignal }): Promise<Uint8Array> {
    return createNativeNotebookPdfBuild(input, { revision: options.revision }).run(options.signal);
}
