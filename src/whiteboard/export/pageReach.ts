import type { Rect } from '../../platform/types'
import { PaintBoundsJob } from '../render/paintBounds'
import type { PaintItem } from '../render/paintStream'
import { yieldToHost } from '../../platform/yieldToHost'

/**
 * Whether a paint item can put anything on a physical page: its conservative envelope (control hulls, ink coverage
 * boxes, stroke reach) meets the page's world rectangle. The page writers clip each page to that rectangle, so an item
 * that cannot reach it adds bytes and nothing visible.
 *
 * The scene already culls a page's nodes by their bounds, but only by bounds its idle cache has certified; a node still
 * pending (any stroke drawn just before a save that does not wait, like leaving the page) passes that cull on EVERY
 * page. Measured: one stroke written through the app's Reload into each page of a 120-page PDF, 46 KB a page, a
 * 109 KB file saved as 6.0 MB (12.2 MB with two strokes). So the writer decides from the item's own geometry, and what
 * a page holds no longer depends on when the save ran. Any doubt (no envelope, a malformed one) writes the item.
 */
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
