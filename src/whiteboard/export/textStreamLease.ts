import type { PaintNodeSource, PaintTextItem } from '../render/paintStream'
import { awaitOutlineResource } from '../text/outlineAbort'
import type { OutlineStreamReply } from '../text/outlineStream'
import type { OutlineWorkerRequest } from '../text/outlineTypes'
import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'

export interface ExportTextStreamLease {
  readonly id: string
  readonly owner: BoardJobIdentity
  current(candidate: BoardJobIdentity): boolean
  complete(): void
  release(): void
}

/** Reserve before cloning the captured paint; release also covers a lost reservation reply. */
export async function openExportTextStream(source: PaintNodeSource, item: PaintTextItem, pageScale: number,
  signal: AbortSignal, chunkPaths = false): Promise<ExportTextStreamLease> {
  const owner: BoardJobIdentity = { session: crypto.randomUUID(), epoch: source.token.vaultEpoch, revision: source.sceneRevision }
  const id = crypto.randomUUID(), client = boardWorker('export')
  const current = (candidate: BoardJobIdentity) => !signal.aborted && source.isCurrent()
    && candidate.session === owner.session && candidate.epoch === owner.epoch && candidate.revision === owner.revision
  const base = { outlineStream: 1 as const, id, owner }, options = { priority: 0 as const, signal }
  const request: OutlineWorkerRequest = { paint: item.paint, faces: item.faces, localToWorld: item.localToWorld,
    material: item.material, pageScale }
  let attempted = false, completed = false, released = false
  const release = () => {
    if (released) return
    released = true
    if (attempted && !completed) void client.request('textOutline', { ...base, mode: 'close' }, owner,
      { priority: 0, cpu: 'light', deadlineMs: 60_000 }, () => true).catch(() => {})
  }
  try {
    for (;;) {
      signal.throwIfAborted()
      attempted = true
      const reply = await client.request<OutlineStreamReply>('textOutline', { ...base, mode: 'reserve', chunkPaths }, owner,
        { ...options, cpu: 'light' }, current)
      if (reply.kind === 'reserved') break
      if (reply.kind !== 'busy') throw new TypeError('Invalid text outline stream reservation')
      await awaitOutlineResource(new Promise<void>(resolveDelay => setTimeout(resolveDelay, 250)), signal)
    }
    const started = await client.request<OutlineStreamReply>('textOutline', { ...base, mode: 'start', request }, owner,
      { ...options, cpu: 'light' }, current)
    if (started.kind !== 'started') throw new TypeError('Invalid text outline stream start')
    return { id, owner, current, complete: () => { completed = true }, release }
  } catch (error) { release(); throw error }
}
