import type { RenderToken } from '../../platform/render/types'
import type { PaintImageProvider } from '../render/resources'
import type { ExportImage } from './displayList'
import type { MediaId } from '../model/media'
import { mediaTileKey, wholeMip } from '../media/mips'

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
        // A PNG or JPEG kept as it is needs no decode: its size comes from the media entry. Decoding it whole only for its size
        // stopped every save of a PDF board holding a picture of about 2000x1500 and up ('Insufficient memory for full-frame image').
        // The type is the blob's, else the media entry's: bytes read back out of a saved PDF's attachments carry no type.
        const known = images.mediaSize?.(item.imageKey) ?? null, type = blob.type || known?.mime || ''
        if (known && !item.inverted && (type === 'image/png' || type === 'image/jpeg')) {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          signal.throwIfAborted()
          return { bytes, mime: type, width: known.width, height: known.height } as const
        }
        // Otherwise a decode: the picture whole, or, when memory refuses that, its finest whole level one decode can hold (a smaller
        // image placed in the same rectangle). The reported size stays the picture's own, which scales a crop's source rectangle.
        let lease
        try { lease = await images.acquire(item.imageKey, token, signal) } catch (error) {
          if (!known || signal.aborted) throw error
          let level = 1
          while (level < 26 && !wholeMip(Math.ceil(known.width / 2 ** level), Math.ceil(known.height / 2 ** level))) level++
          lease = await images.acquire(mediaTileKey({ id: known.id as MediaId, frame: 0, level, column: -1, row: -1 }), token, signal)
        }
        try {
          signal.throwIfAborted()
          const width = known?.width ?? lease.width, height = known?.height ?? lease.height
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError('Invalid image dimensions')
          if (!item.inverted && (type === 'image/png' || type === 'image/jpeg')) {
            const bytes = new Uint8Array(await blob.arrayBuffer())
            signal.throwIfAborted()
            return { bytes, mime: type, width, height } as const
          }
          const canvas = document.createElement('canvas')
          // At the decoded image's own size (a whole level after a refusal), placed by the reported size.
          canvas.width = lease.width; canvas.height = lease.height
          try {
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Canvas 2D is unavailable')
            context.filter = item.inverted ? 'invert(1) hue-rotate(180deg)' : 'none'
            context.drawImage(lease.source, 0, 0, lease.width, lease.height)
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
