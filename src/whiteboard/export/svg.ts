import type { Affine, PageDisplayItem, PageDisplayList, PathCommand, Rect, Rgba } from '../../platform/types'

function number(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Non-finite SVG coordinate')
  return String(value)
}
function pathData(commands: readonly PathCommand[]): string {
  return commands.map(command => command[0] === 'Z' ? 'Z' : `${command[0]}${command.slice(1).map(value => number(value as number)).join(' ')}`).join(' ')
}
function matrix(value: Affine): string { return `matrix(${value.map(number).join(' ')})` }
function rgb(value: Rgba): string { return `rgb(${value.slice(0, 3).map(channel => number(channel * 255)).join(' ')})` }
function bytes64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
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
  let finished = false
  function emit(item: PageDisplayItem, depth: number): string {
    if (depth > 64) throw new RangeError('SVG group nesting exceeds 64 levels')
    switch (item.kind) {
      case 'group': {
        let clip = ''
        if (item.clip) {
          const id = `clip${nextClip++}`
          definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${pathData(item.clip.d)}" clip-rule="${item.clip.fillRule ?? 'nonzero'}"/></clipPath>`)
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
    append(item) { if (finished) throw new Error('SVG writer is closed'); body.push(emit(item, 0)) },
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
