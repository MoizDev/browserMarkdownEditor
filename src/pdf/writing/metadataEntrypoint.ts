// One fixed, separately authenticated module; all PDF-lib work remains in the opaque worker.
export { createPdfWriterRuntime } from './nativeHandlers';
export { PdfInkInspector } from './inkInspection';
export { inspectPdfNotebook } from './notebookInspection';
export { inspectLegacyPdfInk } from './legacyInkInspection';
