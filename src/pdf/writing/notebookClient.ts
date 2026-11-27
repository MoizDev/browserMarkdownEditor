import { getSharedPdfPool } from '../session/startup';
import { newPdfWriteId } from './writeIdentity';
import { typedPdfWriter } from './writerClient';
import { validNotebookSourcePath } from './notebookPointer';
import type { IncrementalEmittedPdf } from './incrementalTypes';
export type { IncrementalEmittedPdf } from './incrementalTypes';

export async function buildNativeNotebookFromEmittedPdf(emitted: IncrementalEmittedPdf,
    notebookSource: { readonly path: string }, options: { readonly signal: AbortSignal }): Promise<Uint8Array> {
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
        const output = await writer.request('writer.buildNotebook', args, { signal: options.signal, priority: 2 });
        options.signal.throwIfAborted();
        if (output.revision !== revision || output.writeId !== writeId) throw new Error('Notebook writer returned another build');
        return new Uint8Array(output.bytes);
    } finally { await writer.close(); }
}
