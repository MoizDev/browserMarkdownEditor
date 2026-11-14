import type { PaintNodeSource, PaintTextItem } from '../render/paintStream'
import type { OutlineStreamReply } from '../text/outlineStream'
import type { OutlineWorkerRequest } from '../text/outlineTypes'
import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'

export interface ExportTextStreamLease {
  readonly id: string
  readonly owner: BoardJobIdentity
  current(candidate: BoardJobIdentity): boolean
  /** One advance of the worker stream. The request is tracked until its worker retirement. */
  pull(signal: AbortSignal): Promise<OutlineStreamReply>
  /** Tracks an outside request that reads this stream (for example svgChunk), so release waits for it. */
  track(request: Promise<unknown>): void
  /** Resolves only after every request on this stream has physically retired and the worker has closed it. */
  release(): Promise<void>
}

/** Reserves a worker stream slot (queued by the worker until one is free), then starts it. Every
 * request is tracked; release awaits their physical retirement before the close, and close before
 * dropping the paint, faces and source that the worker may still be reading. */
export async function openExportTextStream(source: PaintNodeSource, item: PaintTextItem, pageScale: number,
  signal: AbortSignal, chunkPaths = false): Promise<ExportTextStreamLease> {
  const owner: BoardJobIdentity = { session: crypto.randomUUID(), epoch: source.token.vaultEpoch, revision: source.sceneRevision }
  const id = crypto.randomUUID(), client = boardWorker('export')
  const current = (candidate: BoardJobIdentity) => !signal.aborted && source.isCurrent()
    && candidate.session === owner.session && candidate.epoch === owner.epoch && candidate.revision === owner.revision
  const base = { outlineStream: 1 as const, id, owner }
  const request: OutlineWorkerRequest = { paint: item.paint, faces: item.faces, localToWorld: item.localToWorld,
    material: item.material, pageScale }
  // The request above holds the paint and the item's actual face table, and release closes over it,
  // so neither can be dropped while the worker may still read them.
  const requests = new Set<Promise<unknown>>()
  const track = <T>(value: Promise<T>): Promise<T> => { requests.add(value); return value }
  const send = <T>(body: Record<string, unknown>, sendSignal: AbortSignal): Promise<T> =>
    track(client.request<T>('textOutline', { ...base, ...body }, owner, { priority: 0, cpu: 'light', signal: sendSignal }, current))
  let attempted = false
  let releasing: Promise<void> | null = null
  const release = (): Promise<void> => releasing ??= (async () => {
    // In-flight advances and the start must physically retire before the worker sees close.
    await Promise.allSettled([...requests].map(value => client.whenRetired(value)))
    if (attempted) {
      const closing = track(client.request<OutlineStreamReply>('textOutline', { ...base, mode: 'close' }, owner,
        { priority: 0, cpu: 'light', deadlineMs: 60_000 }, () => true))
      // A failed close leaves the worker to be retired by its own deadline; we wait for that retirement, not an ack.
      await closing.catch(() => undefined)
      await client.whenRetired(closing)
    }
    await Promise.allSettled([...requests].map(value => client.whenRetired(value)))
  })()
  try {
    attempted = true
    const reserved = await send<OutlineStreamReply>({ mode: 'reserve', chunkPaths }, signal)
    if (reserved.kind !== 'reserved') throw new TypeError('Invalid text outline stream reservation')
    const started = await send<OutlineStreamReply>({ mode: 'start', request }, signal)
    if (started.kind !== 'started') throw new TypeError('Invalid text outline stream start')
  } catch (error) { await release(); throw error }
  return {
    id, owner, current,
    pull: pullSignal => send<OutlineStreamReply>({ mode: 'nextBatch' }, pullSignal),
    track: value => { track(value) },
    release,
  }
}
