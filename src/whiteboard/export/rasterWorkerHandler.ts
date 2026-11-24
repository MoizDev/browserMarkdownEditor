import type { PathCommand, Rect } from '../../platform/types'
import type { WorkerContext } from '../../platform/workers/serve'
import { Path2dJob } from '../render/reference/coverage2d'
import { paintItem2d } from '../render/reference/paint2d'
import type { PaintResources2d, PreparedPath2d } from '../render/reference/paint2d'
import { BoardFonts } from '../text/fonts'
import { encodePng } from './png'
import { exportRows } from './tiles'
import type { RasterWireImage, RasterWireItem } from './rasterWire'

interface Entry { items: RasterWireItem[]; images: Map<string, ImageBitmap>; timer: ReturnType<typeof setTimeout> }
interface Key { streamId: string }
interface Chunk extends Key { items: RasterWireItem[]; images: RasterWireImage[] }
interface Encode extends Key { width: number; height: number; world: Rect; scale: number; background?: string; clipboard?: boolean }
const streams = new Map<string, Entry>()
let fonts: BoardFonts | undefined
function key(args: unknown): string {
  const id = (args as Key | null)?.streamId
  if (typeof id !== 'string' || !id) throw new Error('Invalid raster stream identity')
  return id
}
function drop(id: string): void {
  const entry = streams.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  streams.delete(id)
  for (const image of entry.images.values()) image.close()
}
function touch(id: string, entry: Entry): void {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => drop(id), 120_000)
}
export function rasterStart(args: unknown): null {
  const id = key(args)
  if (streams.has(id)) throw new Error('Duplicate raster stream')
  streams.set(id, { items: [], images: new Map(), timer: setTimeout(() => drop(id), 120_000) })
  return null
}
export function rasterChunk(args: unknown): null {
  const id = key(args), entry = streams.get(id), chunk = args as Chunk
  if (!entry || !Array.isArray(chunk.items) || chunk.items.length > 64 || !Array.isArray(chunk.images)) throw new Error('Invalid raster chunk')
  try {
    for (const { key: imageKey, bitmap } of chunk.images) {
      if (entry.images.has(imageKey)) { bitmap.close(); throw new Error('Duplicate raster image') }
      entry.images.set(imageKey, bitmap)
    }
    entry.items.push(...chunk.items)
    touch(id, entry)
    return null
  } catch (error) { for (const image of chunk.images) image.bitmap.close(); drop(id); throw error }
}
export async function rasterEncode(args: unknown, context: WorkerContext): Promise<Blob> {
  const id = key(args), entry = streams.get(id), input = args as Encode
  if (!entry) throw new Error('Unknown raster stream')
  clearTimeout(entry.timer)
  const { width, height, world, scale, background } = input
  if (![world.x, world.y, world.width, world.height, scale].every(Number.isFinite) || scale <= 0 || world.width <= 0 || world.height <= 0) {
    drop(id); throw new RangeError('Invalid raster projection')
  }
  const paths = new WeakMap<RasterWireItem, PreparedPath2d>(), clips = new Map<string, PreparedPath2d>()
  async function prepare(commands: readonly PathCommand[]): Promise<PreparedPath2d> {
    const first = commands[0], origin = first && first[0] !== 'Z' ? [first[1], first[2]] as const : [0, 0] as const
    const job = new Path2dJob(commands, origin)
    while (job.step(1024) === 'pending') await context.slice()
    context.signal.throwIfAborted()
    if (!job.result) throw new Error('Raster path construction cancelled')
    return { path: job.result, origin }
  }
  try {
    let preparedCount = 0
    for (const item of entry.items) {
      context.signal.throwIfAborted()
      for (const clip of item.clips) if (!clips.has(clip.key)) clips.set(clip.key, await prepare(clip.d))
      if (item.kind === 'path') paths.set(item, await prepare(item.d))
      else if (item.kind === 'text') {
        fonts ??= new BoardFonts((globalThis as unknown as { fonts: FontFaceSet }).fonts)
        for (const face of item.faces.faces) if (face.loaded && !await fonts.load(face.key)) throw new Error('Export font could not be loaded')
        context.signal.throwIfAborted()
      }
      if (++preparedCount % 128 === 0) await context.slice()
    }
    const resources: PaintResources2d = {
      path(item) { const value = paths.get(item as RasterWireItem); if (!value) throw new Error('Missing raster path'); return value },
      clip(id) { const value = clips.get(id); if (!value) throw new Error('Missing raster clip'); return value },
      image(id) { const value = entry.images.get(id); if (!value) throw new Error('Missing raster image'); return value },
    }
    const rows = exportRows(width, height, async tile => {
      context.signal.throwIfAborted()
      const apron = 2, canvas = new OffscreenCanvas(tile.width + apron * 2, tile.height + apron * 2)
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('Offscreen Canvas 2D is unavailable')
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height) }
        ctx.setTransform(scale, 0, 0, scale, -world.x * scale - tile.x + apron, -world.y * scale - tile.y + apron)
        let count = 0
        for (const item of entry.items) {
          context.signal.throwIfAborted()
          paintItem2d(ctx, item, resources)
          if (++count % 128 === 0) await context.slice()
        }
        return new Uint8Array(ctx.getImageData(apron, apron, tile.width, tile.height).data.buffer)
      } finally { canvas.width = 0; canvas.height = 0 }
    }, { clipboard: input.clipboard, signal: context.signal })
    return await encodePng(width, height, rows, { clipboard: input.clipboard, pixelsPerWorldUnit: scale, signal: context.signal })
  } finally { drop(id) }
}
export function rasterCancel(args: unknown): null { drop(key(args)); return null }
