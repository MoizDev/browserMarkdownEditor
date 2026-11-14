import type { RenderToken } from '../../platform/render/types'
import type { PaintImageProvider } from '../render/resources'
import type { ExportImage } from './displayList'

/** Read the exact pinned frame represented by imageKey, not the latest mutable media. */
export type ReadExportImage = (imageKey: string, signal: AbortSignal) => Promise<Blob>

/** Normalize the writer's PNG/JPEG inputs. Native PNG/JPEG bytes survive untouched when no
 * inversion is requested; other formats and inversion use the already-admitted clean decoder. */
export function createExportImageResolver(
  token: RenderToken, images: PaintImageProvider, read: ReadExportImage, signal: AbortSignal,
): ExportImage {
  const cache = new Map<string, ReturnType<ExportImage>>()
  return (item, requestSignal) => {
    requestSignal?.throwIfAborted()
    signal.throwIfAborted()
    const key = `${item.inverted ? 'inverted:' : 'original:'}${item.imageKey}`
    let pending = cache.get(key)
    if (!pending) {
      pending = (async () => {
        const blob = await read(item.imageKey, signal)
        signal.throwIfAborted()
        const lease = await images.acquire(item.imageKey, token, signal)
        try {
          signal.throwIfAborted()
          const { width, height } = lease
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError('Invalid image dimensions')
          if (!item.inverted && (blob.type === 'image/png' || blob.type === 'image/jpeg')) {
            const bytes = new Uint8Array(await blob.arrayBuffer())
            signal.throwIfAborted()
            return { bytes, mime: blob.type, width, height } as const
          }
          const canvas = document.createElement('canvas')
          canvas.width = width; canvas.height = height
          try {
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Canvas 2D is unavailable')
            context.filter = item.inverted ? 'invert(1) hue-rotate(180deg)' : 'none'
            context.drawImage(lease.source, 0, 0, width, height)
            const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image PNG encoding failed')), 'image/png'))
            signal.throwIfAborted()
            const bytes = new Uint8Array(await png.arrayBuffer())
            signal.throwIfAborted()
            return { bytes, mime: 'image/png' as const, width, height }
          } finally { canvas.width = 0; canvas.height = 0 }
        } finally { lease.release() }
      })()
      cache.set(key, pending)
    }
    return pending.then(result => { signal.throwIfAborted(); requestSignal?.throwIfAborted(); return result })
  }
}
