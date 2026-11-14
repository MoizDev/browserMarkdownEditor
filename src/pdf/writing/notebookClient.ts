import { getSharedPdfPool } from '../session/startup';
import type { DisplayPdfInput } from './types';
import { newPdfWriteId } from './writeIdentity';
import { typedPdfWriter } from './writerClient';
import { validNotebookSourcePath } from './notebookPointer';

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

/** The incremental PDF is generated output, never an imported-source editing capability. */
export async function buildNativeNotebookFromEmittedPdf(emitted: {
    readonly revision: number; readonly bytes: Uint8Array; readonly hashes: readonly string[];
    readonly pages: readonly { readonly index: number; readonly width: number; readonly height: number }[];
}, notebookSource: { readonly path: string }, options: { readonly signal: AbortSignal }): Promise<Uint8Array> {
    options.signal.throwIfAborted();
    if (!emitted || !Number.isSafeInteger(emitted.revision) || emitted.revision < 0 || !(emitted.bytes instanceof Uint8Array) ||
        emitted.bytes.byteLength < 8 || emitted.bytes.byteLength >= 0x80000000 || !validNotebookSourcePath(notebookSource?.path) ||
        !Array.isArray(emitted.pages) || !emitted.pages.length || emitted.pages.length > 100_000 || !Array.isArray(emitted.hashes) ||
        emitted.hashes.length !== emitted.pages.length || emitted.hashes.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
        throw new TypeError('Invalid emitted notebook PDF');
    }
    const pages = emitted.pages.map((page, index) => {
        if (!page || page.index !== index || !Number.isFinite(page.width) || page.width <= 0 || page.width > 14_400 ||
            !Number.isFinite(page.height) || page.height <= 0 || page.height > 14_400) throw new TypeError('Invalid emitted notebook page');
        return { width: page.width, height: page.height };
    });
    const writeId = newPdfWriteId(), revision = emitted.revision;
    const args = { kind: 'pre-emitted' as const, revision, writeId, pages, notebookSource: { path: notebookSource.path },
        pdf: new Blob([emitted.bytes.slice()], { type: 'application/pdf' }) };
    options.signal.throwIfAborted();
    const writer = typedPdfWriter(await getSharedPdfPool().writer({ signal: options.signal }));
    try {
        options.signal.throwIfAborted();
        // The pool independently verifies the mark, transferred bytes, pointer union and every page corner.
        const output = await writer.request('writer.buildNotebook', args, { signal: options.signal, priority: 2 });
        options.signal.throwIfAborted();
        if (output.revision !== revision || output.writeId !== writeId) throw new Error('Notebook writer returned another build');
        return new Uint8Array(output.bytes);
    } finally { await writer.close(); }
}
