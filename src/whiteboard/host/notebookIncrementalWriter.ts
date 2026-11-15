import type { IncrementalPdfWriter } from '../export/incrementalPdf';
import { pdfEngineAvailableInBuild } from '../../utils/pdfEngineAvailability';

/** The emitter never receives a source PDF. Only the isolated native notebook writer
 * adds the source pointer/write mark and independently verifies the finished bytes. */
export function createNativeNotebookIncrementalWriter(revision: number, sourcePath: string): IncrementalPdfWriter {
    // Absence at build time is an explicit generated-only writer route. An eligible
    // native engine failing integrity or a build never switches engines on failure.
    const native = pdfEngineAvailableInBuild();
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
                if (native) {
                    const { buildNativeNotebookFromEmittedPdf } = await import('../../pdf/writing/notebookClient');
                    active.throwIfAborted();
                    return buildNativeNotebookFromEmittedPdf(emitted, { path: sourcePath }, { signal: active });
                }
                const { finishGeneratedNotebookPdf } = await import('../../pdf/writing/client');
                active.throwIfAborted();
                return finishGeneratedNotebookPdf(emitted, { path: sourcePath }, { signal: active });
            } }).open(options, signal);
        },
    };
}
