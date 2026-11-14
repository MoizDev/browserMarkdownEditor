import type { Rect } from '../../platform/types'
import type { PaintFrame } from '../render/paintStream'
import { paintFrameDisplayList } from './displayList'
import type { ExportImage } from './displayList'
import { displayListSvg } from './svg'

/** Export the same pinned frame and order as PNG/PDF; the caller retains frame/image leases. */
export async function captureSvg(
  frame: PaintFrame, world: Readonly<Rect>, scale: number, images: ExportImage, signal: AbortSignal,
): Promise<Blob> {
  if (![world.x, world.y, world.width, world.height, scale].every(Number.isFinite)
      || world.width <= 0 || world.height <= 0 || scale <= 0) throw new RangeError('Invalid capture extent')
  signal.throwIfAborted()
  const list = await paintFrameDisplayList(frame, 0, scale, images, signal)
  signal.throwIfAborted()
  return displayListSvg(list, world)
}
