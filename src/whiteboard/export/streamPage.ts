import type { PageDisplayItem, PageDisplayList, PathCommand, Rect } from '../../platform/types'
import { PaintStreamJob } from '../render/paintStream'
import type { PaintItem, PaintNodeSource } from '../render/paintStream'
import { paintItemDisplay } from './displayList'
import type { ExportImage, ExportText } from './displayList'

/** One immutable source per physical page. Never publish a partial list: the caller holds
 * the source's revision/media leases until the resulting page has been handed to the writer. */
export async function streamPageDisplayList(
  source: PaintNodeSource, page: number, world: Readonly<Rect>, scale: number, image: ExportImage, signal: AbortSignal, text?: ExportText,
): Promise<PageDisplayList> {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isFinite(scale) || scale <= 0
      || ![world.x, world.y, world.width, world.height].every(Number.isFinite) || world.width <= 0 || world.height <= 0) {
    throw new RangeError('Invalid export page')
  }
  const chunk: PaintItem[] = [], items: PageDisplayItem[] = []
  const job = new PaintStreamJob(source, item => { chunk.push(item) })
  try {
    let complete = false
    while (!complete) {
      signal.throwIfAborted()
      const state = job.step(64)
      if (state === 'stale' || state === 'cancelled') throw new Error(`Paint capture ${state}`)
      complete = state === 'complete'
      for (const item of chunk) {
        signal.throwIfAborted()
        items.push(await paintItemDisplay(item, scale, image, signal, text))
        if (!source.isCurrent()) throw new Error('Paint capture stale')
      }
      chunk.length = 0
      if (!complete) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal.throwIfAborted()
    if (!source.isCurrent()) throw new Error('Paint capture stale')
    const clip: PathCommand[] = [['M', world.x, world.y], ['L', world.x + world.width, world.y],
      ['L', world.x + world.width, world.y + world.height], ['L', world.x, world.y + world.height], ['Z']]
    return { page, items: [{ kind: 'group', transform: [1, 0, 0, 1, -world.x, -world.y], clip: { d: clip }, items }] }
  } catch (error) { job.cancel(); throw error }
}
