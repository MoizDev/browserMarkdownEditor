import type { PageDisplayList, Rect } from '../../platform/types'
import type { PaintNodeSource } from '../render/paintStream'
import type { DisplayPdfWriter } from './capturePdf'
import type { ExportImage } from './displayList'
import { streamPageDisplayList } from './streamPage'

export interface PdfStreamPage {
  readonly source: PaintNodeSource
  readonly world: Readonly<Rect>
  readonly paper?: PageDisplayList
}

/** Build each clipped physical page independently, preserving one pinned board revision. */
export async function streamPdf(
  pages: readonly PdfStreamPage[], scale: number, image: ExportImage, writer: DisplayPdfWriter,
  signal: AbortSignal, notebookSource?: { path: string },
): Promise<Uint8Array> {
  if (!pages.length || !Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid PDF capture')
  const first = pages[0].source
  const output: Array<{ width: number; height: number; displayList: PageDisplayList; paper?: PageDisplayList }> = []
  for (let page = 0; page < pages.length; page++) {
    signal.throwIfAborted()
    const { source, world, paper } = pages[page]
    const a = first.token, b = source.token
    if (source.sceneRevision !== first.sceneRevision || a.vaultEpoch !== b.vaultEpoch || a.documentId !== b.documentId
        || a.bytesGeneration !== b.bytesGeneration || a.session !== b.session) throw new Error('PDF pages must share one pinned revision')
    if (paper && paper.page !== page) throw new RangeError('Paper page does not match output page')
    const displayList = await streamPageDisplayList(source, page, world, scale, image, signal)
    output.push({ width: world.width, height: world.height, paper, displayList })
  }
  signal.throwIfAborted()
  return writer({ schema: 1, pages: output, notebookSource }, { signal })
}
