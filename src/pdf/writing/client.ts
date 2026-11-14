import { createWorkerClient } from '../../platform/workers/client';
import type { DisplayPdfInput, InkPackage, InkPageInput } from './types';
import type { IncrementalEmittedPdf } from './incrementalTypes';
import { validNotebookSourcePath } from './notebookPointer';

// A separate, lazy worker keeps the new writer behind its entry point and cannot
// interfere with a legacy annotation save that is already in flight.
const client = createWorkerClient({
    name: 'display-pdf-writer', protocol: 1,
    spawn: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
});

/** Produces staged bytes only. The caller owns vault, revision and destination checks. */
export function buildDisplayPdf(input: DisplayPdfInput, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    return client.request<Uint8Array>('build', input, { priority: 2, cpu: 'governed', signal: options.signal });
}

/** Finalize generated incremental notebook pages without selecting a PDF engine. */
export async function finishGeneratedNotebookPdf(emitted: IncrementalEmittedPdf, notebookSource: { readonly path: string },
    options: { readonly signal: AbortSignal }): Promise<Uint8Array> {
    options.signal.throwIfAborted();
    if (!emitted || typeof emitted !== 'object' || Array.isArray(emitted) ||
        Object.keys(emitted).some(key => !['revision', 'bytes', 'hashes', 'pages'].includes(key)) ||
        !Number.isSafeInteger(emitted.revision) || emitted.revision < 0 || !(emitted.bytes instanceof Uint8Array) ||
        emitted.bytes.byteLength < 8 || emitted.bytes.byteLength >= 0x80000000 || !notebookSource ||
        typeof notebookSource !== 'object' || Array.isArray(notebookSource) || Object.keys(notebookSource).some(key => key !== 'path') ||
        !validNotebookSourcePath(notebookSource.path) || notebookSource.path.length > 4096 || !Array.isArray(emitted.pages) ||
        !emitted.pages.length || emitted.pages.length > 100_000 || !Array.isArray(emitted.hashes) ||
        emitted.hashes.length !== emitted.pages.length || emitted.hashes.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
        throw new TypeError('Invalid generated notebook PDF');
    }
    const pages = emitted.pages.map((page, index) => {
        if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).some(key => !['index', 'width', 'height'].includes(key)) ||
            page.index !== index || !Number.isFinite(page.width) || page.width <= 0 || page.width > 14_400 ||
            !Number.isFinite(page.height) || page.height <= 0 || page.height > 14_400) throw new TypeError('Invalid generated notebook page');
        return { width: page.width, height: page.height };
    });
    const args = { kind: 'pre-emitted' as const, revision: emitted.revision, pdf: new Blob([emitted.bytes.slice()], { type: 'application/pdf' }),
        pages, notebookSource: { path: notebookSource.path } };
    options.signal.throwIfAborted();
    const output = await client.request<Uint8Array>('finishNotebook', args, { priority: 2, cpu: 'governed', signal: options.signal });
    options.signal.throwIfAborted();
    if (!(output instanceof Uint8Array) || output.byteLength < 8 || output.byteLength >= 0x80000000) throw new Error('Invalid generated notebook output');
    return output;
}

/** Emit resolution-free ink for a separate assembler; this never receives an imported PDF. */
export function emitInkPdf(pages: readonly InkPageInput[], options: { signal?: AbortSignal } = {}): Promise<InkPackage> {
    return client.request<InkPackage>('emitInk', pages, { priority: 2, cpu: 'governed', signal: options.signal });
}
