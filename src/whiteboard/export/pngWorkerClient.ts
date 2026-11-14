import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'
import { checkPngSize } from './png'
import { exportRows } from './tiles'
import type { RenderExportTile, TiledPngOptions } from './tiles'

/** One shared platform worker compresses rows with backpressure; rasterization stays with
 * the capture owner and every transfer owns its bytes, never the live band backing store. */
export async function encodeTiledPngInWorker(
  width: number, height: number, render: RenderExportTile, identity: BoardJobIdentity, options: TiledPngOptions = {},
): Promise<Blob> {
  checkPngSize(width, height, options.clipboard)
  options.signal?.throwIfAborted()
  const streamId = crypto.randomUUID()
  const client = boardWorker('export')
  const abort = new AbortController()
  const cancelled = () => abort.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', cancelled, { once: true })
  if (options.signal?.aborted) cancelled()
  const rows = exportRows(width, height, render, { ...options, signal: abort.signal })[Symbol.asyncIterator]()
  const isCurrent = (candidate: BoardJobIdentity) => !abort.signal.aborted && candidate.session === identity.session
    && candidate.epoch === identity.epoch && candidate.revision === identity.revision
  let pulling = false
  let failure: unknown
  const off = client.on('pngPull', (payload, candidate) => {
    if (!isCurrent(candidate) || !payload || typeof payload !== 'object' || (payload as { streamId?: unknown }).streamId !== streamId) return
    if (pulling) { failure = new Error('Duplicate PNG row request'); abort.abort(failure); return }
    pulling = true
    void rows.next().then(next => {
      if (abort.signal.aborted) return
      const row = next.done ? undefined : Uint8Array.from(next.value)
      pulling = false
      return client.request<null>('pngRow', row ? { streamId, row } : { streamId, end: true }, identity,
        { priority: 0, cpu: 'light', signal: abort.signal, transfer: row ? [row.buffer] : [] }, isCurrent)
    }).catch(error => { failure = error; abort.abort(error) })
  })
  try {
    const result = await client.request<Blob>('pngStart', { streamId, width, height, clipboard: options.clipboard,
      pixelsPerWorldUnit: options.pixelsPerWorldUnit }, identity, { priority: 0, signal: abort.signal }, isCurrent)
    if (!(result instanceof Blob) || result.type !== 'image/png') throw new TypeError('Invalid PNG worker result')
    return result
  } catch (error) { throw failure ?? error }
  finally {
    off()
    abort.abort()
    options.signal?.removeEventListener('abort', cancelled)
    void rows.return?.(undefined).catch(() => {})
  }
}
