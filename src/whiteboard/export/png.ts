// F-EXPORT-002/006: rows arrive at export resolution, independent of display DPR.
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

export function checkPngSize(width: number, height: number, clipboard = false): PngSize {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError('PNG dimensions must be positive integers')
  }
  const side = clipboard ? 8192 : 16384
  const scale = Math.min(1, side / width, side / height, Math.sqrt(2 ** 28 / width / height))
  if (scale < 1) throw new ExportTooLarge(scale)
  return { width, height }
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

/** Encode unpremultiplied RGBA rows without allocating a full output canvas. */
export async function encodePng(
  width: number,
  height: number,
  rows: AsyncIterable<Uint8Array>,
  options: { pixelsPerWorldUnit?: number; clipboard?: boolean; signal?: AbortSignal } = {},
): Promise<Blob> {
  checkPngSize(width, height, options.clipboard)
  const density = options.pixelsPerWorldUnit
  if (density !== undefined && (!Number.isFinite(density) || density <= 0 || density * 72 / 0.0254 > 0xffffffff)) {
    throw new RangeError('Invalid PNG density')
  }
  options.signal?.throwIfAborted()
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
    const pixelsPerMetre = Math.round(density * 72 / 0.0254)
    view.setUint32(0, pixelsPerMetre)
    view.setUint32(4, pixelsPerMetre)
    phys[8] = 1
    parts.push(chunk('pHYs', phys))
  }

  const iterator = rows[Symbol.asyncIterator]()
  let count = 0
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
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
      parts.push(chunk('IDAT', next.value))
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  options.signal?.throwIfAborted()
  parts.push(chunk('IEND', new Uint8Array(0)))
  return new Blob(parts, { type: 'image/png' })
}
