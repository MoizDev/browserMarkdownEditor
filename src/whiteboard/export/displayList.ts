import type { Affine, PageDisplayItem, PageDisplayList, PathCommand } from '../../platform/types'
import { coverageOutline } from '../ink/outline'
import type { PaintFrame, PaintImageItem, PaintItem } from '../render/paintStream'

/** The image resolver returns a pinned, export-ready PNG/JPEG: crop and inversion are baked
 * into its bytes. The caller owns any image leases until this promise settles. */
export type ExportImage = (item: PaintImageItem, signal?: AbortSignal) => Promise<{
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
}>

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

async function displayItem(item: PaintItem, scale: number, image: ExportImage, signal?: AbortSignal): Promise<PageDisplayItem> {
  let leaf: PageDisplayItem
  if (item.kind === 'image') {
    const data = await image(item, signal)
    signal?.throwIfAborted()
    leaf = { kind: 'image', rect: { ...item.rect }, transform: item.localToWorld, ...data, opacity: item.opacity, blend: item.blend }
  } else {
    const [a, b, c, d0] = item.localToWorld
    const effectiveScale = Math.max(Number.MIN_VALUE, scale * Math.hypot(a, b, c, d0))
    const d = item.kind === 'ink' ? [...coverageOutline(item.coverage, effectiveScale)] : [...item.d]
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
  frame: PaintFrame, page: number, scale: number, image: ExportImage, signal?: AbortSignal,
): Promise<PageDisplayList> {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid export page or scale')
  const items: PageDisplayItem[] = []
  for (const band of [frame.underlay, frame.content]) {
    for (const item of band) {
      signal?.throwIfAborted()
      items.push(await displayItem(item, scale, image, signal))
    }
  }
  signal?.throwIfAborted()
  return { page, items }
}
