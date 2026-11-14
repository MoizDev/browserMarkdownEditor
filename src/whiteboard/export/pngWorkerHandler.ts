import type { WorkerContext } from '../../platform/workers/serve'
import { checkPngSize, encodePng } from './png'

interface Start {
  streamId: string
  width: number
  height: number
  clipboard?: boolean
  pixelsPerWorldUnit?: number
}
interface Row { streamId: string; row?: Uint8Array; end?: boolean }
interface Stream { waiting: boolean; delivered?: IteratorResult<Uint8Array> }
const streams = new Map<string, Stream>()

/** A start task holds the governed permit. Row delivery runs as light tasks, otherwise it
 * would wait for the permit held by the task it must unblock. */
export async function pngStart(args: unknown, context: WorkerContext): Promise<Blob> {
  const input = args as Start
  if (!input || typeof input.streamId !== 'string' || !input.streamId || streams.has(input.streamId)) throw new Error('Invalid PNG stream identity')
  checkPngSize(input.width, input.height, input.clipboard)
  const state: Stream = { waiting: false }
  streams.set(input.streamId, state)
  async function* rows(): AsyncGenerator<Uint8Array> {
    while (true) {
      state.waiting = true
      context.emit('pngPull', { streamId: input.streamId })
      while (!state.delivered) await context.slice()
      const next = state.delivered
      state.delivered = undefined
      if (next.done) return
      yield next.value
    }
  }
  try {
    return await encodePng(input.width, input.height, rows(), { clipboard: input.clipboard, pixelsPerWorldUnit: input.pixelsPerWorldUnit })
  } finally { streams.delete(input.streamId) }
}

export function pngRow(args: unknown): null {
  const input = args as Row
  const state = input && streams.get(input.streamId)
  if (!state || !state.waiting || state.delivered || (input.end === true) === (input.row instanceof Uint8Array)) {
    throw new Error('Unexpected PNG stream row')
  }
  state.waiting = false
  state.delivered = input.end ? { done: true, value: undefined } : { done: false, value: input.row! }
  return null
}
