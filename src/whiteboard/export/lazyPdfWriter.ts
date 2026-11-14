import type { IncrementalPdfWriter } from './incrementalPdf';

/** Generated print PDFs load their worker only when an export actually starts. */
export function createLazyIncrementalPdfWriter(): IncrementalPdfWriter {
    return {
        kind: 'incremental-pdf',
        async open(options, signal) {
            signal.throwIfAborted();
            const { createIncrementalPdfWriter } = await import('../../pdf/writing/incrementalClient');
            signal.throwIfAborted();
            return createIncrementalPdfWriter().open(options, signal);
        },
    };
}
