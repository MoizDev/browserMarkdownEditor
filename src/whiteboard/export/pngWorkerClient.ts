import { checkPngSize } from './png'
import { exportRows } from './tiles'
import type { RenderExportTile, TiledPngOptions } from './tiles'
import type { PngWorkerRequest, PngWorkerResponse } from './pngWorkerProtocol'

/** Keep rasterization in the capture owner and compression in a dedicated, disposable worker.
 * One requested row at a time gives the renderer backpressure and preserves the band bound. */
export function encodeTiledPngInWorker(
  width: number, height: number, render: RenderExportTile, options: TiledPngOptions = {},
): Promise<Blob> {
  checkPngSize(width, height, options.clipboard)
  options.signal?.throwIfAborted()
  const worker = new Worker(new URL('./png.worker.ts', import.meta.url), { type: 'module' })
  const rows = exportRows(width, height, render, options)[Symbol.asyncIterator]()
  return new Promise((resolve, reject) => {
    let settled = false
    const post = (message: PngWorkerRequest, transfer: Transferable[] = []) => worker.postMessage(message, transfer)
    function finish(error?: unknown, result?: Blob): void {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', cancelled)
      worker.terminate()
      void rows.return?.().catch(() => {})
      if (error !== undefined) reject(error)
      else resolve(result!)
    }
    function cancelled(): void { finish(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    options.signal?.addEventListener('abort', cancelled, { once: true })
    worker.onerror = event => finish(new Error(event.message || 'PNG worker failed'))
    worker.onmessageerror = () => finish(new Error('PNG worker message could not be read'))
    worker.onmessage = (event: MessageEvent<PngWorkerResponse>) => {
      const message = event.data
      if (message.kind === 'result') finish(undefined, message.blob)
      else if (message.kind === 'error') finish(new Error(message.message))
      else if (message.kind === 'pull') {
        rows.next().then(next => {
          if (settled) return
          if (next.done) post({ kind: 'end' })
          else {
            // The yielded row views its whole band; transfer only an owned copy.
            const row = Uint8Array.from(next.value)
            post({ kind: 'row', row }, [row.buffer])
          }
        }, finish)
      }
    }
    post({ kind: 'start', width, height, clipboard: options.clipboard, pixelsPerWorldUnit: options.pixelsPerWorldUnit })
    if (options.signal?.aborted) cancelled()
  })
}
