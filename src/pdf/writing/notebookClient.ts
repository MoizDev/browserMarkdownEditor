import { getSharedPdfPool } from '../session/startup';
import type { DisplayPdfInput } from './types';
import { newPdfWriteId } from './writeIdentity';
import { typedPdfWriter } from './writerClient';

/** Generated notebook pages only: the pool independently reopens and verifies the
 * marked output after releasing the producing heap, before any bytes reach App. */
export async function buildNativeNotebookPdf(input: DisplayPdfInput,
    options: { readonly revision: number; readonly signal?: AbortSignal }): Promise<Uint8Array> {
    const { revision, signal } = options;
    signal?.throwIfAborted();
    if (!input || input.schema !== 1 || !input.notebookSource || !Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError('Native notebook export requires a captured revision and source path');
    }
    const writeId = newPdfWriteId();
    const args = { revision, writeId, displayListSchema: 1 as const,
        pages: input.pages.map(page => ({ ...page })), notebookSource: { path: input.notebookSource.path } };
    const writer = typedPdfWriter(await getSharedPdfPool().writer({ signal }));
    try {
        signal?.throwIfAborted();
        const product = await writer.request('writer.buildNotebook', args, { signal, priority: 2 });
        signal?.throwIfAborted();
        if (product.revision !== revision || product.writeId !== writeId) throw new Error('Notebook writer returned another build');
        return new Uint8Array(product.bytes);
    } finally { await writer.close(); }
}
