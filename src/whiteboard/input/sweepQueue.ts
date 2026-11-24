import type { NodeId } from '../model/ids'

export interface SweepPoint { readonly x: number; readonly y: number }
export interface SweptSelectionCursor {
  step(budget: { readonly deadline: number; readonly maxVisits: number }): { readonly status: 'pending' | 'complete' | 'stale' | 'cancelled'; readonly ids: readonly NodeId[] }
  cancel(): void
  wait?(wake: () => void): () => void
}
export interface SweepQueueServices {
  beginSweep(from: SweepPoint, to: SweepPoint, topOnly: boolean): SweptSelectionCursor
  sceneRevision(): number
  now(): number
  schedule(callback: () => void, onDrop?: () => void): () => void
  preview(ids: ReadonlySet<NodeId>): void
}

const SEGMENTS_PER_BLOCK = 1024
interface SegmentBlock { readonly coordinates: Float64Array; readonly flags: Uint8Array }

/** Exact input is retained in compact blocks until completion: a changed scene
 * restarts the entire path instead of committing a mixture of revisions. */
export class SweepQueue {
  private readonly blocks: SegmentBlock[] = []
  private readonly visible = new Set<NodeId>()
  private count = 0
  private next = 0
  private revision: number
  private cursor: SweptSelectionCursor | null = null
  private scheduled: (() => void) | null = null
  private waiting: (() => void) | null = null
  private epoch = 0
  private closed = false
  private settled = false
  private resolve!: (ids: ReadonlySet<NodeId>) => void
  private reject!: (error: unknown) => void
  readonly result: Promise<ReadonlySet<NodeId>>

  constructor(private readonly services: SweepQueueServices, private readonly maxVisits = 64) {
    if (!Number.isSafeInteger(maxVisits) || maxVisits <= 0) throw new RangeError('Invalid sweep work budget')
    this.revision = services.sceneRevision()
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.result.catch(() => {})
  }

  add(from: SweepPoint, to: SweepPoint, topOnly: boolean): void {
    if (this.closed || this.settled) return
    if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw new RangeError('Invalid sweep segment')
    if (!Number.isSafeInteger(this.count + 1)) throw new RangeError('Sweep segment count exhausted')
    const blockIndex = Math.floor(this.count / SEGMENTS_PER_BLOCK), index = this.count % SEGMENTS_PER_BLOCK
    let block = this.blocks[blockIndex]
    if (!block) {
      block = { coordinates: new Float64Array(SEGMENTS_PER_BLOCK * 4), flags: new Uint8Array(SEGMENTS_PER_BLOCK) }
      this.blocks.push(block)
    }
    const offset = index * 4
    block.coordinates[offset] = from.x; block.coordinates[offset + 1] = from.y
    block.coordinates[offset + 2] = to.x; block.coordinates[offset + 3] = to.y
    block.flags[index] = Number(topOnly); this.count++
    this.request()
  }

  finish(): Promise<ReadonlySet<NodeId>> {
    if (!this.settled) { this.closed = true; this.request() }
    return this.result
  }

  cancel(): void {
    if (this.settled) return
    this.settled = true; this.epoch++
    const errors: unknown[] = []
    try { this.scheduled?.() } catch (error) { errors.push(error) } finally { this.scheduled = null }
    try { this.waiting?.() } catch (error) { errors.push(error) } finally { this.waiting = null }
    try { this.cursor?.cancel() } catch (error) { errors.push(error) } finally { this.cursor = null }
    this.blocks.length = 0; this.visible.clear()
    try { this.services.preview(new Set()) } catch (error) { errors.push(error) }
    this.reject(errors.length ? new AggregateError(errors, 'Sweep cancellation failed') : new DOMException('Sweep cancelled', 'AbortError'))
  }

  private request(): void {
    if (this.settled || this.scheduled || this.waiting) return
    // A dropped frame must clear the flag too, or every later request is ignored and the release never completes (the input host's contract).
    this.scheduled = this.services.schedule(() => { this.scheduled = null; this.step() }, () => { this.scheduled = null })
  }

  private restart(revision: number): void {
    this.epoch++
    this.waiting?.(); this.waiting = null
    this.cursor?.cancel(); this.cursor = null
    this.revision = revision; this.next = 0; this.visible.clear()
    this.services.preview(new Set())
  }

  private makeCursor(): SweptSelectionCursor {
    const block = this.blocks[Math.floor(this.next / SEGMENTS_PER_BLOCK)], index = this.next % SEGMENTS_PER_BLOCK, offset = index * 4
    return this.services.beginSweep({ x: block.coordinates[offset], y: block.coordinates[offset + 1] },
      { x: block.coordinates[offset + 2], y: block.coordinates[offset + 3] }, !!block.flags[index])
  }

  private wait(cursor: SweptSelectionCursor): void {
    if (!cursor.wait) return
    const epoch = this.epoch
    let awakened = false
    const cancel = cursor.wait(() => {
      awakened = true
      if (this.settled || this.epoch !== epoch || this.cursor !== cursor) return
      this.waiting = null; this.request()
    })
    if (awakened) cancel(); else this.waiting = cancel
  }

  private fail(error: unknown): void {
    if (this.settled) return
    this.settled = true; this.epoch++
    try { this.scheduled?.() } catch { /* Continue releasing the exact source. */ }
    try { this.waiting?.() } catch { /* Continue releasing the exact source. */ }
    try { this.cursor?.cancel() } catch { /* Preserve the original query failure. */ }
    this.scheduled = null; this.waiting = null; this.cursor = null; this.blocks.length = 0; this.visible.clear()
    try { this.services.preview(new Set()) } catch { /* Preserve the original query failure. */ }
    this.reject(error)
  }

  private step(): void {
    if (this.settled) return
    try {
      const revision = this.services.sceneRevision()
      if (revision !== this.revision) this.restart(revision)
      const deadline = this.services.now() + 0.25
      let work = 0, changed = false
      while (this.next < this.count && work++ < this.maxVisits) {
        if (this.services.sceneRevision() !== this.revision) { this.restart(this.services.sceneRevision()); changed = true; break }
        const cursor = this.cursor ??= this.makeCursor()
        const result = cursor.step({ deadline, maxVisits: this.maxVisits })
        if (result.status === 'stale' || this.services.sceneRevision() !== this.revision) {
          this.restart(this.services.sceneRevision()); changed = true; break
        }
        if (result.status === 'cancelled') throw new Error('Sweep cursor cancelled unexpectedly')
        for (const id of result.ids) if (!this.visible.has(id)) { this.visible.add(id); changed = true }
        if (result.status === 'pending') { this.wait(cursor); break }
        this.cursor = null; cursor.cancel(); this.next++
        if (this.services.now() >= deadline) break
      }
      if (changed) this.services.preview(new Set(this.visible))
      if (this.closed && this.next === this.count && this.services.sceneRevision() === this.revision) {
        this.settled = true; this.epoch++; this.blocks.length = 0
        this.resolve(new Set(this.visible)); this.visible.clear()
      } else if (this.next < this.count || this.closed) this.request()
    } catch (error) { this.fail(error) }
  }
}
