import type { PageDisplayItem, Rect } from '../../platform/types'
import type { WorkerContext } from '../../platform/workers/serve'
import { streamTextOutline } from '../text/outline'
import { handleOutlineStream, holdOutlineStream } from '../text/outlineStream'
import type { BoardJobIdentity } from '../workers/protocol'
import type { TextDisplayFrame } from './displayList'
import { createSvgWriter } from './svg'

interface Start { streamId: string; bounds: Rect }
interface Chunk { streamId: string; items?: PageDisplayItem[]; text?: { id: string; owner: BoardJobIdentity; frame: TextDisplayFrame } }
interface Key { streamId: string }
interface Entry { writer: ReturnType<typeof createSvgWriter>; timer: ReturnType<typeof setTimeout>; busy: boolean; cancelled: boolean }
const streams = new Map<string, Entry>()
function drop(id: string, expected?: Entry): void {
  const entry = streams.get(id)
  if (entry && (!expected || entry === expected)) { entry.cancelled = true; clearTimeout(entry.timer); streams.delete(id) }
}
function touch(id: string, entry: Entry): void {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => drop(id, entry), 120_000)
}
function key(args: unknown): string {
  const id = (args as Key | null)?.streamId
  if (typeof id !== 'string' || !id) throw new Error('Invalid SVG stream identity')
  return id
}
export function svgStart(args: unknown): null {
  const id = key(args), input = args as Start
  if (streams.has(id)) throw new Error('Duplicate SVG stream')
  const entry: Entry = { writer: createSvgWriter(input.bounds), timer: setTimeout(() => drop(id, entry), 120_000), busy: false, cancelled: false }
  streams.set(id, entry)
  return null
}
export async function svgChunk(args: unknown, context: WorkerContext): Promise<null> {
  const id = key(args), entry = streams.get(id), { items, text } = args as Chunk
  if (!entry || (text ? items !== undefined : !Array.isArray(items) || items.length > 64)) throw new Error('Invalid SVG chunk')
  if (text && (!text.frame || !Array.isArray(text.frame.transform) || text.frame.transform.length !== 6
      || !text.frame.transform.every(Number.isFinite) || !Array.isArray(text.frame.clips) || text.frame.clips.length > 62
      || text.frame.clips.some(clip => !clip || !Array.isArray(clip.d)
        || (clip.fillRule !== undefined && clip.fillRule !== 'nonzero' && clip.fillRule !== 'evenodd')))) throw new TypeError('Invalid SVG text frame')
  if (entry.busy) throw new Error('SVG stream is already advancing')
  entry.busy = true
  clearTimeout(entry.timer)
  try {
    if (text) {
      const release = holdOutlineStream(text.id, text.owner)
      try {
        const outlines = async function* (): AsyncGenerator<PageDisplayItem> {
          for (;;) {
            context.signal.throwIfAborted()
            const batch = await handleOutlineStream({ outlineStream: 1, mode: 'nextBatch', id: text.id, owner: text.owner },
              context, streamTextOutline, false)
            if (batch.kind !== 'batch') throw new TypeError('Invalid SVG text outline batch')
            yield* batch.items
            if (batch.done) return
          }
        }
        await entry.writer.appendTextCooperative(text.frame, outlines(), context, () => !entry.cancelled)
      } finally { release() }
    } else {
      let count = 0
      for (const item of items!) {
        context.signal.throwIfAborted()
        await entry.writer.appendCooperative(item, context, () => !entry.cancelled)
        if (++count % 16 === 0) await context.slice()
      }
    }
    return null
  } catch (error) { drop(id, entry); throw error }
  finally {
    entry.busy = false
    if (!entry.cancelled && streams.get(id) === entry) touch(id, entry)
  }
}
export function svgFinish(args: unknown): Blob {
  const id = key(args), entry = streams.get(id)
  if (!entry) throw new Error('Unknown SVG stream')
  if (entry.busy) throw new Error('SVG stream is already advancing')
  try { return entry.writer.finish() } finally { drop(id, entry) }
}
export function svgCancel(args: unknown): null { drop(key(args)); return null }
