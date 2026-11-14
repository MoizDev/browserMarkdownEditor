import type { Affine, PageDisplayItem, PageDisplayList, PathCommand } from '../../platform/types'
import { InkOutlineJob } from '../ink/outline'
import type { InkCoverage } from '../ink/outline'
import type { PaintFrame, PaintImageItem, PaintItem, PaintTextItem } from '../render/paintStream'

/** The image resolver returns a pinned, export-ready PNG/JPEG with inversion baked in.
 * Dimensions are the original image pixels; the caller owns leases until this settles. */
export type ExportImage = (item: PaintImageItem, signal?: AbortSignal) => Promise<{
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}>
/** Outlines/fallback are local to the text item; material alpha is already resolved. */
export type ExportText = (item: PaintTextItem, scale: number, signal?: AbortSignal) => Promise<readonly PageDisplayItem[]>

function transformPath(commands: readonly PathCommand[], matrix: Affine): PathCommand[] {
  const [a, b, c, d, e, f] = matrix
  const point = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f]
  return commands.map(command => {
    switch (command[0]) {
      case 'M': return ['M', ...point(command[1], command[2])]
      case 'L': return ['L', ...point(command[1], command[2])]
      case 'C': return ['C', ...point(command[1], command[2]), ...point(command[3], command[4]), ...point(command[5], command[6])]
      case 'Z': return ['Z']
    }
  })
}

export async function inkOutline(coverage: InkCoverage, scale: number, signal?: AbortSignal): Promise<PathCommand[]> {
  const commands: PathCommand[] = []
  const job = new InkOutlineJob(coverage, scale, command => commands.push(command), Number.MAX_SAFE_INTEGER)
  try {
    while (job.step(1024) === 'pending') {
      signal?.throwIfAborted()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal?.throwIfAborted()
    return commands
  } catch (error) { job.cancel(); throw error }
}

export async function paintItemDisplay(item: PaintItem, scale: number, image: ExportImage, signal?: AbortSignal, text?: ExportText): Promise<PageDisplayItem> {
  let leaf: PageDisplayItem
  if (item.kind === 'text') {
    if (!text) throw new Error('Text outline export is unavailable')
    const items = await text(item, scale, signal)
    signal?.throwIfAborted()
    leaf = { kind: 'group', transform: item.localToWorld, items: [...items] }
  } else if (item.kind === 'image') {
    const data = await image(item, signal)
    signal?.throwIfAborted()
    if (!Number.isFinite(data.width) || !Number.isFinite(data.height) || data.width <= 0 || data.height <= 0) throw new RangeError('Invalid export image dimensions')
    const source = item.sourceRect, target = item.rect
    if (source) {
      if (source.width <= 0 || source.height <= 0) throw new RangeError('Invalid export image crop')
      const sx = target.width / source.width, sy = target.height / source.height
      const rect = { x: target.x - source.x * sx, y: target.y - source.y * sy, width: data.width * sx, height: data.height * sy }
      const d: PathCommand[] = [['M', target.x, target.y], ['L', target.x + target.width, target.y],
        ['L', target.x + target.width, target.y + target.height], ['L', target.x, target.y + target.height], ['Z']]
      leaf = { kind: 'group', transform: item.localToWorld, clip: { d }, items: [{ kind: 'image', rect,
        transform: [1, 0, 0, 1, 0, 0], bytes: data.bytes, mime: data.mime, opacity: item.opacity, blend: item.blend }] }
    } else leaf = { kind: 'image', rect: { ...target }, transform: item.localToWorld,
      bytes: data.bytes, mime: data.mime, opacity: item.opacity, blend: item.blend }
  } else {
    const [a, b, c, d0] = item.localToWorld
    const effectiveScale = Math.max(Number.MIN_VALUE, scale * Math.hypot(a, b, c, d0))
    const d = item.kind === 'ink' ? await inkOutline(item.coverage, effectiveScale, signal) : [...item.d]
    const path: PageDisplayItem = item.kind === 'ink'
      ? { kind: 'path', d, fill: item.material.color, fillRule: 'nonzero', blend: item.material.blend }
      : { kind: 'path', d, fill: item.material.fill, fillRule: item.fillRule, blend: item.material.blend,
          stroke: item.material.stroke && { color: item.material.stroke.color, width: item.material.stroke.width,
            cap: item.material.stroke.cap, join: item.material.stroke.join, miterLimit: item.material.stroke.miterLimit,
            dash: item.material.stroke.dash?.array, dashPhase: item.material.stroke.dash?.phase } }
    leaf = { kind: 'group', transform: item.localToWorld, items: [path] }
  }
  // Clips each have an independent absolute transform, not the item's local transform.
  // Re-expressing their geometry in world space avoids applying an ancestor transform twice.
  if (item.clips.length > 62) throw new RangeError('Export clip nesting exceeds 64 levels')
  for (let i = item.clips.length - 1; i >= 0; i--) {
    const clip = item.clips[i]
    leaf = { kind: 'group', clip: { d: transformPath(clip.d, clip.localToWorld), fillRule: clip.fillRule }, items: [leaf] }
  }
  return leaf
}

/** Convert one pinned paint frame, preserving the underlay/content ordering. */
export async function paintFrameDisplayList(
  frame: PaintFrame, page: number, scale: number, image: ExportImage, signal?: AbortSignal, text?: ExportText,
): Promise<PageDisplayList> {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid export page or scale')
  const items: PageDisplayItem[] = []
  let count = 0
  for (const band of [frame.underlay, frame.content]) {
    for (const item of band) {
      if (++count % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
      signal?.throwIfAborted()
      items.push(await paintItemDisplay(item, scale, image, signal, text))
    }
  }
  signal?.throwIfAborted()
  return { page, items }
}
