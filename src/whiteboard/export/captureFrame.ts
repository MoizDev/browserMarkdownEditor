import { PaintStreamJob } from '../render/paintStream'
import type { PaintFrame, PaintItem, PaintNodeSource } from '../render/paintStream'

/** Consume one pinned scene revision in bounded work slices. A stale/cancelled partial stream
 * is never exposed as a frame; the source owner retains its leases until export settles. */
export async function capturePaintFrame(source: PaintNodeSource, signal: AbortSignal): Promise<PaintFrame> {
  const underlay: PaintItem[] = [], content: PaintItem[] = []
  const job = new PaintStreamJob(source, (item, band) => (band === 'underlay' ? underlay : content).push(item))
  try {
    for (;;) {
      signal.throwIfAborted()
      const state = job.step(1024)
      if (state === 'complete') {
        signal.throwIfAborted()
        return { token: source.token, sceneRevision: source.sceneRevision, underlay, content }
      }
      if (state !== 'pending') throw new Error(`Paint capture ${state}`)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  } catch (error) { job.cancel(); throw error }
}
