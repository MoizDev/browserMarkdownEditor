import type { IncrementalPdfWriter } from '../export/incrementalPdf';

/** The emitter never receives a source PDF. Only the isolated native notebook writer
 * adds the source pointer/write mark and independently verifies the finished bytes. */
export function createNativeNotebookIncrementalWriter(revision: number, sourcePath: string): IncrementalPdfWriter {
    return {
        kind: 'incremental-pdf',
        async open(options, signal) {
            signal.throwIfAborted();
            if (options.revision !== revision || options.notebookSource?.path !== sourcePath) {
                throw new Error('Notebook stream does not match its captured source');
            }
            const { createIncrementalPdfWriter } = await import('../../pdf/writing/incrementalClient');
            signal.throwIfAborted();
            return createIncrementalPdfWriter({ onFinish: async (emitted, active) => {
                active.throwIfAborted();
                if (emitted.revision !== revision || emitted.pages.length !== options.pageCount) {
                    throw new Error('Notebook stream returned a different captured revision');
                }
                const { buildNativeNotebookFromEmittedPdf } = await import('../../pdf/writing/notebookClient');
                active.throwIfAborted();
                return buildNativeNotebookFromEmittedPdf(emitted, { path: sourcePath }, { signal: active });
            } }).open(options, signal);
        },
    };
}
