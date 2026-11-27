import { boardWorker } from '../workers/client'
import type { BoardJobIdentity } from '../workers/protocol'
import { checkPngSize } from './png'
import { exportRows } from './tiles'
import type { RenderExportTile, TiledPngOptions } from './tiles'

const ROW_BATCH_BYTES = 4 * 1024 * 1024

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
  const activePulls = new Set<Promise<void>>()
  const off = client.on('pngPull', (payload, candidate) => {
    if (!isCurrent(candidate) || !payload || typeof payload !== 'object' || (payload as { streamId?: unknown }).streamId !== streamId) return
    if (pulling) { failure = new Error('Duplicate PNG row request'); abort.abort(failure); return }
    pulling = true
    const pull = (async () => {
      const parts: Uint8Array[] = []
      let bytes = 0
      while (bytes < ROW_BATCH_BYTES) {
        const next = await rows.next()
        if (abort.signal.aborted || next.done) break
        parts.push(next.value); bytes += next.value.byteLength
      }
      if (abort.signal.aborted) return
      const lease = bytes ? options.memory?.reserve(bytes) : undefined
      if (bytes && options.memory && !lease) throw new Error('Insufficient shared memory for PNG export rows')
      try {
        let band: Uint8Array | undefined
        if (bytes) { band = new Uint8Array(bytes); let at = 0; for (const part of parts) { band.set(part, at); at += part.byteLength } }
        parts.length = 0
        pulling = false
        await client.request<null>('pngRow', band ? { streamId, row: band } : { streamId, end: true }, identity,
          { priority: 0, cpu: 'light', signal: abort.signal, transfer: band ? [band.buffer] : [] }, isCurrent)
      } finally { if (lease) options.memory!.release(lease) }
    })().catch(error => { failure = error; abort.abort(error) })
    activePulls.add(pull)
    void pull.then(() => { activePulls.delete(pull) })
  })
  let startRequest: Promise<Blob> | undefined
  try {
    startRequest = client.request<Blob>('pngStart', { streamId, width, height, clipboard: options.clipboard,
      pixelsPerWorldUnit: options.pixelsPerWorldUnit }, identity, { priority: 0, signal: abort.signal }, isCurrent)
    const result = await startRequest
    if (!(result instanceof Blob) || result.type !== 'image/png') throw new TypeError('Invalid PNG worker result')
    return result
  } catch (error) { throw failure ?? error }
  finally {
    off()
    abort.abort()
    options.signal?.removeEventListener('abort', cancelled)
    await Promise.allSettled([...activePulls])
    await rows.return?.(undefined).catch(() => {})
    if (startRequest) await client.whenRetired(startRequest)
  }
}
