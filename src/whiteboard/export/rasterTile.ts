import type { Rect } from '../../platform/types'
import type { PaintFrame } from '../render/paintStream'
import { paintItem2d } from '../render/reference/paint2d'
import type { PaintResources2d } from '../render/reference/paint2d'
import type { RenderExportTile } from './tiles'

/** Frame and resources are pinned by the capture owner until the export settles. */
export interface RasterTileCapture {
  readonly frame: PaintFrame
  readonly resources: PaintResources2d
  readonly world: Readonly<Rect>
  readonly scale: number
  /** Omit for transparent output; paper is otherwise supplied by the host. */
  readonly background?: string
}

/** Rasterize in output-pixel coordinates using the very same painter as the viewer. */
export function createRasterTileRenderer(capture: RasterTileCapture): RenderExportTile {
  const { frame, resources, world, scale, background } = capture
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(world.x) || !Number.isFinite(world.y)) {
    throw new RangeError('Invalid export projection')
  }
  return async (tile, signal) => {
    signal?.throwIfAborted()
    const canvas = document.createElement('canvas')
    const apron = 2
    canvas.width = tile.width + 2 * apron
    canvas.height = tile.height + 2 * apron
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('Canvas 2D is unavailable')
      if (background) {
        ctx.fillStyle = background
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      ctx.setTransform(scale, 0, 0, scale, -world.x * scale - tile.x + apron, -world.y * scale - tile.y + apron)
      let count = 0
      for (const band of [frame.underlay, frame.content]) {
        for (const item of band) {
          if (++count % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
          signal?.throwIfAborted()
          paintItem2d(ctx, item, resources)
        }
      }
      signal?.throwIfAborted()
      return new Uint8Array(ctx.getImageData(apron, apron, tile.width, tile.height).data.buffer)
    } finally {
      // Release the backing store before the next band allocates a tile.
      canvas.width = 0
      canvas.height = 0
    }
  }
}
