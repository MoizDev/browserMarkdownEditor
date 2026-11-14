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
interface Stream { waiting: boolean; delivered?: IteratorResult<Uint8Array>; rowBytes: number; encoderBytes: number; context: WorkerContext }
const streams = new Map<string, Stream>()
function reportMemory(context: WorkerContext): void {
  let heapBytes = 0
  for (const state of streams.values()) heapBytes += state.rowBytes + state.encoderBytes
  context.emit('mem', { heapBytes })
}

/** A start task holds the governed permit. Row delivery runs as light tasks, otherwise it
 * would wait for the permit held by the task it must unblock. */
export async function pngStart(args: unknown, context: WorkerContext): Promise<Blob> {
  const input = args as Start
  if (!input || typeof input.streamId !== 'string' || !input.streamId || streams.has(input.streamId)) throw new Error('Invalid PNG stream identity')
  checkPngSize(input.width, input.height, input.clipboard)
  const state: Stream = { waiting: false, rowBytes: 0, encoderBytes: 0, context }
  streams.set(input.streamId, state)
  reportMemory(context)
  async function* rows(): AsyncGenerator<Uint8Array> {
    while (true) {
      state.waiting = true
      context.emit('pngPull', { streamId: input.streamId })
      while (!state.delivered) await context.slice()
      const next = state.delivered
      state.delivered = undefined
      if (next.done) return
      try { yield next.value }
      finally { state.rowBytes = 0; reportMemory(context) }
    }
  }
  try {
    return await encodePng(input.width, input.height, rows(), { clipboard: input.clipboard,
      pixelsPerWorldUnit: input.pixelsPerWorldUnit, signal: context.signal,
      ownedBytes(bytes) { state.encoderBytes = bytes; reportMemory(context) } })
  } finally { streams.delete(input.streamId); reportMemory(context) }
}

export function pngRow(args: unknown): null {
  const input = args as Row
  const state = input && streams.get(input.streamId)
  if (!state || !state.waiting || state.delivered || (input.end === true) === (input.row instanceof Uint8Array)) {
    throw new Error('Unexpected PNG stream row')
  }
  state.waiting = false
  state.delivered = input.end ? { done: true, value: undefined } : { done: false, value: input.row! }
  state.rowBytes = input.end ? 0 : input.row!.buffer.byteLength
  reportMemory(state.context)
  return null
}
