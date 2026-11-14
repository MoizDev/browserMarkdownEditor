import type { PageDisplayItem, Rect, Rgba } from '../../platform/types'
import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'
import { PaintStreamJob } from '../render/paintStream'
import type { PaintItem, PaintNodeSource } from '../render/paintStream'
import { createTextDisplayWrapper, paintItemDisplay } from './displayList'
import type { ExportImage } from './displayList'
import { createStreamingExportTextResolver } from './textStreamResolver'

function transferBytes(item: PageDisplayItem): number {
  if (item.kind === 'group') return item.items.reduce((sum, child) => sum + transferBytes(child), 0)
  if (item.kind === 'image') return item.bytes.byteLength
  if (item.kind === 'raster') return item.png.byteLength
  return item.d.length * 64
}

function transferable(item: PageDisplayItem, transfers: Transferable[], owned: boolean): PageDisplayItem {
  if (item.kind === 'group') return { ...item, items: item.items.map(child => transferable(child, transfers, owned)) }
  if (item.kind === 'image') {
    const bytes = Uint8Array.from(item.bytes); transfers.push(bytes.buffer)
    return { ...item, bytes }
  }
  if (item.kind === 'raster') {
    if (owned && item.png.buffer instanceof ArrayBuffer && item.png.byteOffset === 0 && item.png.byteLength === item.png.buffer.byteLength) {
      transfers.push(item.png.buffer)
      return item
    }
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
  const text = createStreamingExportTextResolver(source, signal)
  const current = (candidate: BoardJobIdentity) => !signal.aborted && source.isCurrent()
    && candidate.session === identity.session && candidate.epoch === identity.epoch && candidate.revision === identity.revision
  const opts = { priority: 0 as const, signal }
  const chunk: PaintItem[] = []
  const job = new PaintStreamJob(source, item => { chunk.push(item) })
  let started = false, finished = false
  async function send(items: PageDisplayItem[], owned = false): Promise<void> {
    let offset = 0
    while (offset < items.length) {
      signal.throwIfAborted()
      let end = offset, bytes = 0
      while (end < items.length && end - offset < 64) {
        const next = transferBytes(items[end])
        if (end > offset && bytes + next > 16 * 1024 * 1024) break
        bytes += next; end++
      }
      const transfer: Transferable[] = []
      const payload = items.slice(offset, end).map(item => transferable(item, transfer, owned))
      await client.request('svgChunk', { streamId, items: payload }, identity, { ...opts, transfer }, current)
      offset = end
    }
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
        if (item.kind === 'text') {
          await send(items)
          items.length = 0
          const wrap = createTextDisplayWrapper(item)
          const parts: PageDisplayItem[] = []
          let partBytes = 0
          for await (const part of text(item, scale, signal)) {
            signal.throwIfAborted()
            const wrapped = wrap([part])
            parts.push(wrapped)
            partBytes += transferBytes(wrapped)
            if (parts.length >= 64 || partBytes >= 4 * 1024 * 1024) {
              await send(parts, true)
              parts.length = 0; partBytes = 0
            }
            if (!source.isCurrent()) throw new Error('Paint capture stale')
          }
          await send(parts, true)
        } else items.push(await paintItemDisplay(item, scale, image, signal))
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
