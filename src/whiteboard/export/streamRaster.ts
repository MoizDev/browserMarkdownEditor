import type { Rect } from '../../platform/types'
import type { PaintItem, PaintNodeSource } from '../render/paintStream'
import { PaintStreamJob } from '../render/paintStream'
import type { PaintImageProvider } from '../render/resources'
import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'
import { inkOutline } from './displayList'
import { checkPngSize } from './png'
import type { RasterWireImage, RasterWireItem } from './rasterWire'

async function wire(item: PaintItem, scale: number, signal: AbortSignal): Promise<RasterWireItem> {
  if (item.kind !== 'ink') return item
  const [a, b, c, d] = item.localToWorld
  const coverage = await inkOutline(item.coverage, Math.max(Number.MIN_VALUE, scale * Math.hypot(a, b, c, d)), signal)
  return { kind: 'path', key: item.key, nodeId: item.nodeId, geometryKey: item.geometryKey,
    localToWorld: item.localToWorld, clips: item.clips, d: coverage, fillRule: 'nonzero',
    material: { fill: item.material.color, blend: item.material.blend } }
}

/** Send bounded geometry chunks and owned image copies, then rasterize and compress entirely
 * in the shared export worker. The caller retains the pinned source through settlement. */
export async function streamRasterPng(
  source: PaintNodeSource, images: PaintImageProvider, world: Readonly<Rect>, scale: number,
  signal: AbortSignal, options: { background?: string; clipboard?: boolean } = {},
): Promise<Blob> {
  if (![world.x, world.y, world.width, world.height, scale].every(Number.isFinite)
      || world.width <= 0 || world.height <= 0 || scale <= 0) throw new RangeError('Invalid raster extent')
  const width = Math.ceil(world.width * scale), height = Math.ceil(world.height * scale)
  checkPngSize(width, height, options.clipboard)
  signal.throwIfAborted()
  const identity: BoardJobIdentity = { session: crypto.randomUUID(), epoch: source.token.vaultEpoch, revision: source.sceneRevision }
  const streamId = crypto.randomUUID(), client = boardWorker('export')
  const current = (candidate: BoardJobIdentity) => !signal.aborted && source.isCurrent()
    && candidate.session === identity.session && candidate.epoch === identity.epoch && candidate.revision === identity.revision
  const opts = { priority: 0 as const, signal }
  const sent = new Set<string>(), chunk: PaintItem[] = []
  const job = new PaintStreamJob(source, item => { chunk.push(item) })
  let started = false, finished = false
  try {
    started = true
    await client.request('rasterStart', { streamId }, identity, opts, current)
    let complete = false
    while (!complete) {
      signal.throwIfAborted()
      const state = job.step(64)
      if (state === 'stale' || state === 'cancelled') throw new Error(`Paint capture ${state}`)
      complete = state === 'complete'
      const items: RasterWireItem[] = [], bitmaps: RasterWireImage[] = []
      try {
        for (const item of chunk) {
          signal.throwIfAborted()
          items.push(await wire(item, scale, signal))
          if (item.kind === 'image' && !sent.has(item.imageKey)) {
            const lease = await images.acquire(item.imageKey, source.token, signal)
            try {
              signal.throwIfAborted()
              const bitmap = await createImageBitmap(lease.source as ImageBitmapSource)
              if (signal.aborted) { bitmap.close(); signal.throwIfAborted() }
              bitmaps.push({ key: item.imageKey, bitmap })
              sent.add(item.imageKey)
            } finally { lease.release() }
          }
          if (!source.isCurrent()) throw new Error('Paint capture stale')
        }
        chunk.length = 0
        if (items.length || bitmaps.length) await client.request('rasterChunk', { streamId, items, images: bitmaps }, identity,
          { ...opts, transfer: bitmaps.map(image => image.bitmap) }, current)
      } finally { for (const image of bitmaps) image.bitmap.close() }
      if (!complete && !items.length) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    const result = await client.request<Blob>('rasterEncode', { streamId, width, height, world: { ...world }, scale, ...options }, identity, opts, current)
    if (!(result instanceof Blob) || result.type !== 'image/png') throw new TypeError('Invalid PNG worker result')
    finished = true
    return result
  } finally {
    job.cancel()
    if (started && !finished) void client.request('rasterCancel', { streamId }, identity,
      { priority: 0, cpu: 'light', deadlineMs: 5_000 }, () => true).catch(() => {})
  }
}
