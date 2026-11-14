import type { NodeId } from '../model/ids'

export interface SweepPoint { readonly x: number; readonly y: number }
export interface SweptSelectionCursor {
  step(budget: { readonly deadline: number; readonly maxVisits: number }): { readonly status: 'pending' | 'complete' | 'stale' | 'cancelled'; readonly ids: readonly NodeId[] }
  cancel(): void
}
export interface SweepQueueServices {
  beginSweep(from: SweepPoint, to: SweepPoint, topOnly: boolean): SweptSelectionCursor
  sceneRevision(): number
  now(): number
  schedule(callback: () => void): () => void
  preview(ids: ReadonlySet<NodeId>): void
}
interface Segment {
  readonly from: SweepPoint
  readonly to: SweepPoint
  readonly topOnly: boolean
  cursor: SweptSelectionCursor | null
  ids: Set<NodeId>
  complete: boolean
}

// The same bounded path queue serves eraser and scribble selection. Any scene
// revision change restarts every segment; never commit a mixture of revisions.
export class SweepQueue {
  private readonly segments: Segment[] = []
  private readonly visible = new Set<NodeId>()
  private next = 0
  private revision: number
  private scheduled: (() => void) | null = null
  private closed = false
  private cancelled = false
  private resolve!: (ids: ReadonlySet<NodeId>) => void
  private reject!: (error: unknown) => void
  readonly result: Promise<ReadonlySet<NodeId>>
  constructor(private readonly services: SweepQueueServices, private readonly maxVisits = 64) {
    this.revision = services.sceneRevision()
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.result.catch(() => {})
  }
  add(from: SweepPoint, to: SweepPoint, topOnly: boolean): void {
    if (this.closed || this.cancelled) return
    this.segments.push({ from: { ...from }, to: { ...to }, topOnly, cursor: null, ids: new Set(), complete: false })
    this.request()
  }
  finish(): Promise<ReadonlySet<NodeId>> { this.closed = true; this.request(); return this.result }
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true; this.scheduled?.(); this.scheduled = null
    for (const segment of this.segments) segment.cursor?.cancel()
    this.services.preview(new Set())
    this.reject(new DOMException('Sweep cancelled', 'AbortError'))
  }
  private request(): void {
    if (!this.cancelled && !this.scheduled) this.scheduled = this.services.schedule(() => { this.scheduled = null; this.step() })
  }
  private restart(revision: number): void {
    this.revision = revision
    this.next = 0
    this.visible.clear()
    for (const segment of this.segments) { segment.cursor?.cancel(); segment.cursor = null; segment.ids.clear(); segment.complete = false }
    this.services.preview(new Set())
  }
  private step(): void {
    if (this.cancelled) return
    try {
      const revision = this.services.sceneRevision()
      if (revision !== this.revision) this.restart(revision)
      const segment = this.segments[this.next]
      if (segment) {
        segment.cursor ??= this.services.beginSweep(segment.from, segment.to, segment.topOnly)
        const result = segment.cursor.step({ deadline: this.services.now() + 0.25, maxVisits: this.maxVisits })
        if (result.status === 'stale' || this.services.sceneRevision() !== this.revision) this.restart(this.services.sceneRevision())
        else if (result.status === 'cancelled') throw new Error('Sweep cursor cancelled unexpectedly')
        else {
          for (const id of result.ids) { segment.ids.add(id); this.visible.add(id) }
          segment.complete = result.status === 'complete'
          if (segment.complete) this.next++
          this.services.preview(new Set(this.visible))
        }
      }
      if (this.closed && this.next === this.segments.length && this.services.sceneRevision() === this.revision) {
        this.cancelled = true
        this.resolve(new Set(this.visible))
      } else if (this.next < this.segments.length || this.closed) this.request()
    } catch (error) { this.cancelled = true; for (const segment of this.segments) segment.cursor?.cancel(); this.reject(error) }
  }
}
