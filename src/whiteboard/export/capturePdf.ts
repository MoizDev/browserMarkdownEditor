import type { PageDisplayList, Rect } from '../../platform/types'
import type { PaintFrame } from '../render/paintStream'
import { paintFrameDisplayList } from './displayList'
import type { ExportImage } from './displayList'

/** Structural writer boundary: the lazy host passes the PDF domain's buildDisplayPdf. */
export type DisplayPdfWriter = (input: {
  schema: 1
  pages: readonly { width: number; height: number; displayList: PageDisplayList; paper?: PageDisplayList }[]
  notebookSource?: { path: string }
}, options: { signal?: AbortSignal }) => Promise<Uint8Array>

export interface PdfCapturePage {
  readonly frame: PaintFrame
  readonly world: Readonly<Rect>
  /** Exact procedural paper for this target page, already in page coordinates. */
  readonly paper?: PageDisplayList
}

/** Project each pinned world rectangle into its physical page; PDF writer clips at page bounds. */
export async function capturePdf(
  pages: readonly PdfCapturePage[], scale: number, images: ExportImage, writer: DisplayPdfWriter,
  signal: AbortSignal, notebookSource?: { path: string },
): Promise<Uint8Array> {
  if (!pages.length || !Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid PDF capture')
  const output: Array<{ width: number; height: number; displayList: PageDisplayList; paper?: PageDisplayList }> = []
  for (let page = 0; page < pages.length; page++) {
    signal.throwIfAborted()
    const { frame, world, paper } = pages[page]
    if (![world.x, world.y, world.width, world.height].every(Number.isFinite) || world.width <= 0 || world.height <= 0) throw new RangeError('Invalid PDF page extent')
    if (paper && paper.page !== page) throw new RangeError('Paper page does not match output page')
    const list = await paintFrameDisplayList(frame, page, scale, images, signal)
    signal.throwIfAborted()
    output.push({ width: world.width, height: world.height, paper,
      displayList: { page, items: [{ kind: 'group', transform: [1, 0, 0, 1, -world.x, -world.y], items: list.items }] } })
  }
  signal.throwIfAborted()
  return writer({ schema: 1, pages: output, notebookSource }, { signal })
}
