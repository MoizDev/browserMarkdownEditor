import type { Rect } from '../../platform/types'

export class ExportTooLarge extends Error {
  constructor(readonly suggestedScale: number) {
    super('Export is too large')
    this.name = 'ExportTooLarge'
  }
}

export interface PngSize {
  width: number
  height: number
}

const DOWNLOAD_SIDE = 65535, DOWNLOAD_PIXELS = 2 ** 32
const CLIPBOARD_SIDE = 8192, CLIPBOARD_PIXELS = 2 ** 28
function limitsFor(clipboard: boolean): { side: number; pixels: number } {
  return clipboard ? { side: CLIPBOARD_SIDE, pixels: CLIPBOARD_PIXELS } : { side: DOWNLOAD_SIDE, pixels: DOWNLOAD_PIXELS }
}

export function checkPngSize(width: number, height: number, clipboard = false): PngSize {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError('PNG dimensions must be positive integers')
  }
  const { side, pixels } = limitsFor(clipboard)
  const scale = Math.min(1, side / width, side / height, Math.sqrt(pixels / width / height))
  if (scale < 1) throw new ExportTooLarge(scale)
  return { width, height }
}

export function pngScaleLimit(world: Readonly<{ width: number; height: number }>, clipboard = false): number {
  const { side, pixels } = limitsFor(clipboard)
  return Math.min(side / world.width, side / world.height, Math.sqrt(pixels / world.width / world.height)) * (1 - 1e-9)
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  return value >>> 0
})

function crc32(part: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of part) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(12 + data.length)
  const view = new DataView(result.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) result[4 + i] = type.charCodeAt(i)
  result.set(data, 8)
  view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)))
  return result
}

export async function encodePng(
  width: number,
  height: number,
  rows: AsyncIterable<Uint8Array>,
  options: { pixelsPerWorldUnit?: number; clipboard?: boolean; signal?: AbortSignal; ownedBytes?: (bytes: number) => void } = {},
): Promise<Blob> {
  checkPngSize(width, height, options.clipboard)
  const density = options.pixelsPerWorldUnit
  const pixelsPerMetre = density === undefined ? undefined : Math.round(density * 72 / 0.0254)
  if (density !== undefined && (!Number.isFinite(density) || density <= 0 || !Number.isSafeInteger(pixelsPerMetre)
      || pixelsPerMetre! < 1 || pixelsPerMetre! > 0xffffffff)) {
    throw new RangeError('Invalid PNG density')
  }
  options.signal?.throwIfAborted()
  let partBytes = 0, filterBytes = 0, compressedBytes = 0, reporting = true
  const report = () => { if (reporting) options.ownedBytes?.(partBytes + filterBytes + compressedBytes) }
  try {
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header[8] = 8
  header[9] = 6
  const parts: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('sRGB', new Uint8Array([0]))]
  if (density !== undefined) {
    const phys = new Uint8Array(9)
    const view = new DataView(phys.buffer)
    view.setUint32(0, pixelsPerMetre!)
    view.setUint32(4, pixelsPerMetre!)
    phys[8] = 1
    parts.push(chunk('pHYs', phys))
  }

  partBytes = header.byteLength + parts.reduce<number>((sum, part) => sum + (part instanceof Uint8Array ? part.buffer.byteLength : 0), 0)
  report()
  const iterator = rows[Symbol.asyncIterator]()
  let count = 0
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        filterBytes = 0; report()
        options.signal?.throwIfAborted()
        const next = await iterator.next()
        if (next.done) {
          if (count !== height) throw new RangeError('Too few PNG rows')
          controller.close()
          return
        }
        if (count >= height || next.value.length !== width * 4) throw new RangeError('Invalid PNG row')
        const pixels = next.value
        let rawScore = 0
        let subScore = 0
        for (let i = 0; i < pixels.length; i++) {
          const raw = pixels[i]
          const sub = (raw - (i >= 4 ? pixels[i - 4] : 0)) & 255
          rawScore += Math.min(raw, 256 - raw)
          subScore += Math.min(sub, 256 - sub)
        }
        const row = new Uint8Array(1 + width * 4)
        filterBytes = row.byteLength; report()
        if (subScore < rawScore) {
          row[0] = 1
          for (let i = 0; i < pixels.length; i++) row[i + 1] = pixels[i] - (i >= 4 ? pixels[i - 4] : 0)
        } else row.set(pixels, 1)
        count++
        controller.enqueue(row)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() { await iterator.return?.() },
  })
  const reader = input.pipeThrough(new CompressionStream('deflate')).getReader()
  const abort = () => { void reader.cancel(options.signal?.reason).catch(() => {}) }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      options.signal?.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      compressedBytes = next.value.buffer.byteLength; report()
      const encoded = chunk('IDAT', next.value)
      partBytes += encoded.byteLength; parts.push(encoded); report()
      compressedBytes = 0; report()
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  options.signal?.throwIfAborted()
  const end = chunk('IEND', new Uint8Array(0))
  parts.push(end); partBytes += end.byteLength; report()
  return new Blob(parts, { type: 'image/png' })
  } finally { reporting = false; options.ownedBytes?.(0) }
}

export async function splicePngDensity(blob: Blob, worldRect: Readonly<Rect>, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  if (!(blob instanceof Blob) || ![worldRect.x, worldRect.y, worldRect.width, worldRect.height].every(Number.isFinite)
      || worldRect.width <= 0 || worldRect.height <= 0 || blob.size < 45) throw new RangeError('Invalid PNG density source')
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
  signal.throwIfAborted()
  if (!signature.every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) throw new TypeError('Invalid PNG signature')
  const header = new Uint8Array(await blob.slice(8, 33).arrayBuffer())
  signal.throwIfAborted()
  const headView = new DataView(header.buffer)
  if (headView.getUint32(0) !== 13 || String.fromCharCode(...header.subarray(4, 8)) !== 'IHDR') throw new TypeError('Invalid PNG header')
  const width = headView.getUint32(8), height = headView.getUint32(12)
  if (!width || !height) throw new RangeError('Invalid PNG dimensions')
  const pixelsPerWorldUnit = Math.sqrt((width / worldRect.width) * (height / worldRect.height))
  const pixelsPerMetre = Math.round(pixelsPerWorldUnit * 72 / 0.0254)
  if (!Number.isSafeInteger(pixelsPerMetre) || pixelsPerMetre < 1 || pixelsPerMetre > 0xffffffff) throw new RangeError('Invalid PNG density')
  const phys = new Uint8Array(9), physView = new DataView(phys.buffer)
  physView.setUint32(0, pixelsPerMetre); physView.setUint32(4, pixelsPerMetre); phys[8] = 1
  const parts: BlobPart[] = [blob.slice(0, 33), chunk('pHYs', phys)]
  let offset = 33, chunks = 1, sawData = false, ended = false
  while (offset < blob.size) {
    signal.throwIfAborted()
    if (++chunks > 1_000_000 || blob.size - offset < 12) throw new TypeError('Invalid PNG chunk sequence')
    const bytes = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer())
    signal.throwIfAborted()
    const length = new DataView(bytes.buffer).getUint32(0), type = String.fromCharCode(...bytes.subarray(4, 8))
    const end = offset + 12 + length
    if (length > 0x7fffffff || end > blob.size || !/^[A-Za-z]{4}$/.test(type) || type === 'IHDR') throw new TypeError('Invalid PNG chunk')
    if (type === 'IDAT') sawData = true
    if (type === 'IEND') {
      if (length !== 0 || !sawData || end !== blob.size) throw new TypeError('Invalid PNG end')
      ended = true
    }
    if (type !== 'pHYs') parts.push(blob.slice(offset, end))
    offset = end
    if (ended) break
  }
  if (!ended) throw new TypeError('PNG is incomplete')
  signal.throwIfAborted()
  return new Blob(parts, { type: 'image/png' })
}
