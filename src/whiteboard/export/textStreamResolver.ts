import type { PageDisplayItem } from '../../platform/types'
import type { PaintNodeSource, PaintTextItem } from '../render/paintStream'
import { awaitOutlineResource } from '../text/outlineAbort'
import type { OutlineStreamReply } from '../text/outlineStream'
import type { OutlineWorkerRequest } from '../text/outlineTypes'
import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'

/** Pull a captured text paint one display item at a time without keeping a worker CPU permit while the sink writes. */
export function createStreamingExportTextResolver(source: PaintNodeSource, signal: AbortSignal) {
  const owner: BoardJobIdentity = { session: crypto.randomUUID(), epoch: source.token.vaultEpoch, revision: source.sceneRevision }
  const client = boardWorker('export')
  const current = (candidate: BoardJobIdentity) => !signal.aborted && source.isCurrent()
    && candidate.session === owner.session && candidate.epoch === owner.epoch && candidate.revision === owner.revision
  return async function* resolve(item: PaintTextItem, pageScale: number, requestSignal?: AbortSignal): AsyncGenerator<PageDisplayItem> {
    const active = requestSignal && requestSignal !== signal ? AbortSignal.any([signal, requestSignal]) : signal
    const id = crypto.randomUUID(), base = { outlineStream: 1 as const, id, owner }
    const options = { priority: 0 as const, signal: active }
    const request: OutlineWorkerRequest = { paint: item.paint, faces: item.faces, localToWorld: item.localToWorld,
      material: item.material, pageScale }
    let attempted = false, completed = false
    try {
      for (;;) {
        active.throwIfAborted()
        attempted = true
        const reply = await client.request<OutlineStreamReply>('textOutline', { ...base, mode: 'reserve' }, owner,
          { ...options, cpu: 'light' }, current)
        if (reply.kind === 'reserved') break
        if (reply.kind !== 'busy') throw new TypeError('Invalid text outline stream reservation')
        await awaitOutlineResource(new Promise<void>(resolveDelay => setTimeout(resolveDelay, 250)), active)
      }
      const started = await client.request<OutlineStreamReply>('textOutline', { ...base, mode: 'start', request }, owner,
        { ...options, cpu: 'light' }, current)
      if (started.kind !== 'started') throw new TypeError('Invalid text outline stream start')
      for (;;) {
        active.throwIfAborted()
        const reply = await client.request<OutlineStreamReply>('textOutline', { ...base, mode: 'next' }, owner, options, current)
        if (reply.kind === 'done') { completed = true; return }
        if (reply.kind !== 'item' || !reply.item || (reply.item.kind !== 'path' && reply.item.kind !== 'raster'))
          throw new TypeError('Invalid text outline stream item')
        yield reply.item
      }
    } finally {
      // Cleanup must reach the worker even after the source, caller, or document was cancelled.
      if (attempted && !completed) void client.request('textOutline', { ...base, mode: 'close' }, owner,
        { priority: 0, cpu: 'light', deadlineMs: 60_000 }, () => true).catch(() => {})
    }
  }
}
