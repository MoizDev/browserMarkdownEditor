import type { PageDisplayList } from '../../platform/types'
import type { IncrementalPdfWriter } from './incrementalPdf'

/** Explicit compatibility writer port; live native hosts supply the incremental sink. */
export type DisplayPdfWriter = (input: {
  schema: 1
  pages: readonly { width: number; height: number; displayList: PageDisplayList; paper?: PageDisplayList }[]
  notebookSource?: { path: string }
}, options: { signal?: AbortSignal }) => Promise<Uint8Array>

export type PdfExportWriter = DisplayPdfWriter | IncrementalPdfWriter
