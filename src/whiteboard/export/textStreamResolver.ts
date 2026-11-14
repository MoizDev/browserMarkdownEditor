import type { PageDisplayItem } from '../../platform/types'
import type { PaintNodeSource, PaintTextItem } from '../render/paintStream'
import type { OutlineStreamReply } from '../text/outlineStream'
import { boardWorker } from '../workers/client'
import { openExportTextStream } from './textStreamLease'

/** Pull a captured text paint without keeping a worker CPU permit while the sink writes. */
export function createStreamingExportTextResolver(source: PaintNodeSource, signal: AbortSignal) {
  const client = boardWorker('export')
  return async function* resolve(item: PaintTextItem, pageScale: number, requestSignal?: AbortSignal): AsyncGenerator<PageDisplayItem> {
    const active = requestSignal && requestSignal !== signal ? AbortSignal.any([signal, requestSignal]) : signal
    const lease = await openExportTextStream(source, item, pageScale, active)
    const base = { outlineStream: 1 as const, id: lease.id, owner: lease.owner }
    try {
      for (;;) {
        active.throwIfAborted()
        const reply = await client.request<OutlineStreamReply>('textOutline', { ...base, mode: 'nextBatch' }, lease.owner,
          { priority: 0, signal: active }, lease.current)
        if (reply.kind !== 'batch' || typeof reply.done !== 'boolean' || !Array.isArray(reply.items) || reply.items.length > 64 || (!reply.done && !reply.items.length))
          throw new TypeError('Invalid text outline stream batch')
        if (reply.done) lease.complete()
        for (const part of reply.items) {
          active.throwIfAborted()
          if (!part || (part.kind !== 'path' && part.kind !== 'raster')) throw new TypeError('Invalid text outline stream item')
          yield part
        }
        if (reply.done) return
      }
    } finally { lease.release() }
  }
}
