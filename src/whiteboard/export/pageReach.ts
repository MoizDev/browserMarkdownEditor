import type { Rect } from '../../platform/types'
import { PaintBoundsJob } from '../render/paintBounds'
import type { PaintItem } from '../render/paintStream'
import { yieldToHost } from '../../platform/yieldToHost'

export async function paintMayReachPage(item: PaintItem, world: Readonly<Rect>, signal: AbortSignal): Promise<boolean> {
  let box: Readonly<Rect> | null
  try {
    const job = new PaintBoundsJob(item)
    while (!job.step(4096)) { await yieldToHost(); signal.throwIfAborted() }
    box = job.result
  } catch (error) {
    if (signal.aborted) throw error
    return true
  }
  if (!box) return true
  return !(box.x > world.x + world.width || box.x + box.width < world.x
    || box.y > world.y + world.height || box.y + box.height < world.y)
}
