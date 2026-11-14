import type { Affine, PageDisplayItem, PageDisplayList, PathCommand, Rect, Rgba } from '../../platform/types'
import { ExportTooLarge } from './png'

const SVG_LIMIT = 512 * 1024 * 1024

function number(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Non-finite SVG coordinate')
  return String(Number(value.toFixed(4)))
}
function pathData(commands: readonly PathCommand[]): string {
  return commands.map(command => command[0] === 'Z' ? 'Z' : `${command[0]}${command.slice(1).map(value => number(value as number)).join(' ')}`).join(' ')
}
function pathLength(commands: readonly PathCommand[]): number {
  let length = 0
  for (const command of commands) {
    length++
    for (let i = 1; i < command.length; i++) length += number(command[i] as number).length + 1
  }
  return length
}
function matrix(value: Affine): string { return `matrix(${value.map(number).join(' ')})` }
function rgb(value: Rgba): string { return `rgb(${value.slice(0, 3).map(channel => number(channel * 255)).join(' ')})` }
function bytes64(bytes: Uint8Array): string {
  const chunks: string[] = []
  // A multiple of three keeps intermediate chunks unpadded and bounds each binary string.
  for (let i = 0; i < bytes.length; i += 32766) chunks.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 32766))))
  return chunks.join('')
}
function rect(value: Rect): string {
  return `x="${number(value.x)}" y="${number(value.y)}" width="${number(value.width)}" height="${number(value.height)}"`
}
function effects(opacity: number | undefined, blend: 'normal' | 'multiply' | undefined): string {
  return `${opacity === undefined ? '' : ` opacity="${number(opacity)}"`}${blend === 'multiply' ? ' style="mix-blend-mode:multiply"' : ''}`
}

/** Chunkable writer; admitted image bytes are embedded before the caller releases its leases. */
export function createSvgWriter(bounds: Readonly<Rect>): { append(item: PageDisplayItem): void; finish(): Blob } {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new RangeError('Invalid SVG extent')
  let nextClip = 0
  const definitions: string[] = [], body: string[] = []
  const clips = new Map<string, string>()
  const clipCacheLimit = 2 * 1024 * 1024
  let clipCacheBytes = 0
  let finished = false, written = 256
  function clipKey(clip: NonNullable<Extract<PageDisplayItem, { kind: 'group' }>['clip']>): string | null {
    // Exported text fragments repeat their enclosing frame clips. Keep this cache bounded even
    // for arbitrary user paths; large, unique clips still serialize normally.
    return clip.d.length <= 512 ? `${clip.fillRule ?? 'nonzero'}\0${pathData(clip.d)}` : null
  }
  function rememberClip(key: string, id: string): void {
    const size = key.length * 2 + 64
    if (size > clipCacheLimit) return
    while (clipCacheBytes + size > clipCacheLimit) {
      const oldest = clips.keys().next().value as string | undefined
      if (oldest === undefined) break
      clips.delete(oldest)
      clipCacheBytes -= oldest.length * 2 + 64
    }
    clips.set(key, id)
    clipCacheBytes += size
  }
  function estimate(item: PageDisplayItem, depth: number): number {
    if (depth > 64) throw new RangeError('SVG group nesting exceeds 64 levels')
    if (item.kind === 'group') {
      const key = item.clip ? clipKey(item.clip) : null
      return 512 + (item.clip && !(key && clips.has(key)) ? pathLength(item.clip.d) : 0)
        + item.items.reduce((sum, child) => sum + estimate(child, depth + 1), 0)
    }
    if (item.kind === 'path') return 512 + pathLength(item.d) + (item.stroke?.dash?.length ?? 0) * 32
    const bytes = item.kind === 'image' ? item.bytes : item.png
    return 512 + 4 * Math.ceil(bytes.byteLength / 3)
  }
  function emit(item: PageDisplayItem, depth: number): string {
    if (depth > 64) throw new RangeError('SVG group nesting exceeds 64 levels')
    switch (item.kind) {
      case 'group': {
        let clip = ''
        if (item.clip) {
          const key = clipKey(item.clip)
          let id = key ? clips.get(key) : undefined
          if (id && key) { clips.delete(key); clips.set(key, id) }
          else {
            id = `clip${nextClip++}`
            definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${pathData(item.clip.d)}" clip-rule="${item.clip.fillRule ?? 'nonzero'}"/></clipPath>`)
            if (key) rememberClip(key, id)
          }
          clip = ` clip-path="url(#${id})"`
        }
        const transform = item.transform ? ` transform="${matrix(item.transform)}"` : ''
        const isolation = item.isolation ? ` opacity="${number(item.isolation.opacity)}" style="isolation:isolate${item.isolation.blend === 'multiply' ? ';mix-blend-mode:multiply' : ''}"` : ''
        return `<g${transform}${clip}${isolation}>${item.items.map(child => emit(child, depth + 1)).join('')}</g>`
      }
      case 'path': {
        const fill = item.fill ? ` fill="${rgb(item.fill)}" fill-opacity="${number(item.fill[3])}" fill-rule="${item.fillRule ?? 'nonzero'}"` : ' fill="none"'
        const stroke = item.stroke ? ` stroke="${rgb(item.stroke.color)}" stroke-opacity="${number(item.stroke.color[3])}" stroke-width="${number(item.stroke.width)}" stroke-linecap="${item.stroke.cap}" stroke-linejoin="${item.stroke.join}" stroke-miterlimit="${number(item.stroke.miterLimit ?? 10)}"${item.stroke.dash ? ` stroke-dasharray="${item.stroke.dash.map(number).join(' ')}" stroke-dashoffset="${number(item.stroke.dashPhase ?? 0)}"` : ''}` : ''
        return `<path d="${pathData(item.d)}"${fill}${stroke}${effects(undefined, item.blend)}/>`
      }
      case 'image': return `<image ${rect(item.rect)} transform="${matrix(item.transform)}" preserveAspectRatio="none" href="data:${item.mime};base64,${bytes64(item.bytes)}"${effects(item.opacity, item.blend)}/>`
      case 'raster': return `<image ${rect(item.rect)} preserveAspectRatio="none" href="data:image/png;base64,${bytes64(item.png)}"${effects(item.opacity, item.blend)}/>`
    }
  }
  return {
    append(item) {
      if (finished) throw new Error('SVG writer is closed')
      if (written + estimate(item, 0) > SVG_LIMIT) throw new ExportTooLarge(0)
      const before = definitions.length
      const part = emit(item, 0)
      written += part.length
      for (let i = before; i < definitions.length; i++) written += definitions[i].length
      if (written > SVG_LIMIT) throw new ExportTooLarge(0)
      body.push(part)
    },
    finish() {
      if (finished) throw new Error('SVG writer is closed')
      finished = true
      return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${number(bounds.width)}" height="${number(bounds.height)}" viewBox="${number(bounds.x)} ${number(bounds.y)} ${number(bounds.width)} ${number(bounds.height)}"><defs>`,
        ...definitions, '</defs>', ...body, '</svg>'], { type: 'image/svg+xml' })
    },
  }
}

/** A self-contained SVG; all image bytes have already been admitted and pinned by export. */
export function displayListSvg(list: PageDisplayList, bounds: Readonly<Rect>): Blob {
  const writer = createSvgWriter(bounds)
  for (const item of list.items) writer.append(item)
  return writer.finish()
}
