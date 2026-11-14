import type { PageDisplayItem, Rect } from '../../platform/types'
import type { WorkerContext } from '../../platform/workers/serve'
import { createSvgWriter } from './svg'

interface Start { streamId: string; bounds: Rect }
interface Chunk { streamId: string; items: PageDisplayItem[] }
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
  const id = key(args), entry = streams.get(id), items = (args as Chunk).items
  if (!entry || !Array.isArray(items) || items.length > 64) throw new Error('Invalid SVG chunk')
  if (entry.busy) throw new Error('SVG stream is already advancing')
  entry.busy = true
  clearTimeout(entry.timer)
  try {
    let count = 0
    for (const item of items) {
      context.signal.throwIfAborted()
      await entry.writer.appendCooperative(item, context, () => !entry.cancelled)
      if (++count % 16 === 0) await context.slice()
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
