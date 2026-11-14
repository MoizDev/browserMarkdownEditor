import type { PageDisplayItem, Rect, Rgba } from '../../platform/types'
import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'
import { PaintStreamJob } from '../render/paintStream'
import type { PaintItem, PaintNodeSource } from '../render/paintStream'
import { paintItemDisplay } from './displayList'
import type { ExportImage } from './displayList'
import { createExportTextResolver } from './textResolver'

function transferable(item: PageDisplayItem, transfers: Transferable[]): PageDisplayItem {
  if (item.kind === 'group') return { ...item, items: item.items.map(child => transferable(child, transfers)) }
  if (item.kind === 'image') {
    const bytes = Uint8Array.from(item.bytes); transfers.push(bytes.buffer)
    return { ...item, bytes }
  }
  if (item.kind === 'raster') {
    const png = Uint8Array.from(item.png); transfers.push(png.buffer)
    return { ...item, png }
  }
  return item
}

/** Stream one pinned scene to the shared export worker; no partial SVG is published. */
export async function streamSvg(
  source: PaintNodeSource, bounds: Readonly<Rect>, scale: number, image: ExportImage,
  signal: AbortSignal, background?: Rgba,
): Promise<Blob> {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, scale].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0 || scale <= 0) throw new RangeError('Invalid SVG capture')
  signal.throwIfAborted()
  const identity: BoardJobIdentity = { session: crypto.randomUUID(), epoch: source.token.vaultEpoch, revision: source.sceneRevision }
  const streamId = crypto.randomUUID(), client = boardWorker('export')
  const text = createExportTextResolver(source, signal)
  const current = (candidate: BoardJobIdentity) => !signal.aborted && source.isCurrent()
    && candidate.session === identity.session && candidate.epoch === identity.epoch && candidate.revision === identity.revision
  const opts = { priority: 0 as const, signal }
  const chunk: PaintItem[] = []
  const job = new PaintStreamJob(source, item => { chunk.push(item) })
  let started = false, finished = false
  async function send(items: PageDisplayItem[]): Promise<void> {
    if (!items.length) return
    const transfer: Transferable[] = []
    const owned = items.map(item => transferable(item, transfer))
    await client.request('svgChunk', { streamId, items: owned }, identity, { ...opts, transfer }, current)
  }
  try {
    started = true
    await client.request('svgStart', { streamId, bounds: { ...bounds } }, identity, opts, current)
    if (background) await send([{ kind: 'path', fill: background, d: [
      ['M', bounds.x, bounds.y], ['L', bounds.x + bounds.width, bounds.y],
      ['L', bounds.x + bounds.width, bounds.y + bounds.height], ['L', bounds.x, bounds.y + bounds.height], ['Z'],
    ] }])
    let complete = false
    while (!complete) {
      signal.throwIfAborted()
      const state = job.step(64)
      if (state === 'stale' || state === 'cancelled') throw new Error(`Paint capture ${state}`)
      complete = state === 'complete'
      const items: PageDisplayItem[] = []
      for (const item of chunk) {
        signal.throwIfAborted()
        items.push(await paintItemDisplay(item, scale, image, signal, text))
        if (!source.isCurrent()) throw new Error('Paint capture stale')
      }
      chunk.length = 0
      await send(items)
      if (!complete && !items.length) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal.throwIfAborted()
    const result = await client.request<Blob>('svgFinish', { streamId }, identity, opts, current)
    if (!(result instanceof Blob) || result.type !== 'image/svg+xml') throw new TypeError('Invalid SVG worker result')
    finished = true
    return result
  } finally {
    job.cancel()
    if (started && !finished) void client.request('svgCancel', { streamId }, identity,
      { priority: 0, cpu: 'light', deadlineMs: 5_000 }, () => true).catch(() => {})
  }
}
