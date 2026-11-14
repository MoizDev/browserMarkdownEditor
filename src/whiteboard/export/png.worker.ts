import { encodePng } from './png'
import type { PngWorkerRequest, PngWorkerResponse } from './pngWorkerProtocol'

const scope = self as unknown as {
  postMessage(message: PngWorkerResponse): void
  onmessage: ((event: MessageEvent<PngWorkerRequest>) => void) | null
}
const abort = new AbortController()
let deliver: ((row: IteratorResult<Uint8Array>) => void) | undefined
let started = false
function send(message: PngWorkerResponse): void { scope.postMessage(message) }
async function* rows(): AsyncGenerator<Uint8Array> {
  while (true) {
    abort.signal.throwIfAborted()
    const next = new Promise<IteratorResult<Uint8Array>>(resolve => { deliver = resolve })
    send({ kind: 'pull' })
    const row = await next
    abort.signal.throwIfAborted()
    if (row.done) return
    yield row.value
  }
}
scope.onmessage = (event: MessageEvent<PngWorkerRequest>) => {
  const message = event.data
  if (message.kind === 'cancel') {
    abort.abort()
    deliver?.({ done: true, value: undefined })
    deliver = undefined
  } else if (message.kind === 'start' && !started) {
    started = true
    encodePng(message.width, message.height, rows(), { clipboard: message.clipboard,
      pixelsPerWorldUnit: message.pixelsPerWorldUnit, signal: abort.signal })
      .then(blob => send({ kind: 'result', blob }), error => send({ kind: 'error', message: String(error) }))
  } else if (message.kind === 'row' || message.kind === 'end') {
    const resolve = deliver
    deliver = undefined
    resolve?.(message.kind === 'row' ? { done: false, value: message.row } : { done: true, value: undefined })
  }
}
