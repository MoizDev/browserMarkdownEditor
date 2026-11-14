import { checkPngSize, encodePng } from './png'

export interface ExportTile {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

// The renderer supplies straight-alpha RGBA for exactly this output rectangle, in output
// pixel coordinates. It owns and releases any intermediate canvas, bitmap and image leases.
export type RenderExportTile = (tile: ExportTile, signal?: AbortSignal) => Promise<Uint8Array>

export interface TiledPngOptions {
  readonly clipboard?: boolean
  readonly pixelsPerWorldUnit?: number
  readonly signal?: AbortSignal
}

const TILE_SIDE = 1024
const BAND_BYTES = 8 * 1024 * 1024

/** Assemble horizontal strips, so even the largest accepted image never needs a full canvas. */
export async function* exportRows(
  width: number,
  height: number,
  render: RenderExportTile,
  options: Pick<TiledPngOptions, 'clipboard' | 'signal'> = {},
): AsyncGenerator<Uint8Array> {
  checkPngSize(width, height, options.clipboard)
  const bandHeight = Math.min(TILE_SIDE, Math.max(1, Math.floor(BAND_BYTES / (width * 4))))
  for (let y = 0; y < height; y += bandHeight) {
    options.signal?.throwIfAborted()
    const h = Math.min(bandHeight, height - y)
    const stride = width * 4
    const band = new Uint8Array(stride * h)
    for (let x = 0; x < width; x += TILE_SIDE) {
      options.signal?.throwIfAborted()
      const w = Math.min(TILE_SIDE, width - x)
      const pixels = await render({ x, y, width: w, height: h }, options.signal)
      options.signal?.throwIfAborted()
      if (pixels.byteLength !== w * h * 4) throw new RangeError('Invalid export tile')
      for (let row = 0; row < h; row++) {
        band.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), row * stride + x * 4)
      }
    }
    for (let row = 0; row < h; row++) {
      options.signal?.throwIfAborted()
      yield band.subarray(row * stride, (row + 1) * stride)
    }
  }
}

export function encodeTiledPng(
  width: number,
  height: number,
  render: RenderExportTile,
  options: TiledPngOptions = {},
): Promise<Blob> {
  return encodePng(width, height, exportRows(width, height, render, options), options)
}
