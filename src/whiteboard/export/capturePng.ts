import type { Rect } from '../../platform/types'
import type { PaintFrame } from '../render/paintStream'
import type { PaintImageProvider } from '../render/resources'
import { checkPngSize } from './png'
import { encodeTiledPngInWorker } from './pngWorkerClient'
import { prepareRaster } from './prepareRaster'
import { createRasterTileRenderer } from './rasterTile'

export interface PngCapture {
  readonly frame: PaintFrame
  readonly images: PaintImageProvider
  readonly world: Readonly<Rect>
  readonly scale: number
  readonly background?: string
  readonly clipboard?: boolean
}

/** The caller owns the immutable frame through completion. Resource leases are held until
 * the worker has encoded every row, including on cancellation or failed image decoding. */
export async function capturePng(capture: PngCapture, signal: AbortSignal): Promise<Blob> {
  const { frame, images, world, scale, background, clipboard } = capture
  if (![world.x, world.y, world.width, world.height, scale].every(Number.isFinite)
      || world.width <= 0 || world.height <= 0 || scale <= 0) throw new RangeError('Invalid capture extent')
  const width = Math.ceil(world.width * scale), height = Math.ceil(world.height * scale)
  checkPngSize(width, height, clipboard)
  signal.throwIfAborted()
  const prepared = await prepareRaster(frame, scale, images, signal)
  try {
    return await encodeTiledPngInWorker(width, height,
      createRasterTileRenderer({ frame, resources: prepared.resources, world, scale, background }),
      { clipboard, pixelsPerWorldUnit: scale, signal })
  } finally { prepared.dispose() }
}
