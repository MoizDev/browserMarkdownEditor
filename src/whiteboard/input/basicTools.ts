import { sampleSurface, type FinishReason, type GestureOwner, type Modifiers, type RealSample, type Tool } from './tool'
import type { TouchPanSample } from '../../platform/render/scheduler'
import { PanFlingSamples } from './panFling'
import type { NodeId } from '../model/ids'
import { SweepQueue, type SweepQueueServices } from './sweepQueue'

export interface InkPoint { readonly x: number; readonly y: number }
export interface EraserContext extends SweepQueueServices {
  hold(): () => void
  registerPending(cancel: () => void): () => void
  prepareCommit(ids: ReadonlySet<NodeId>, signal: AbortSignal): Promise<void>
  armCommit(): void
  finishCommit(): void
  cancelCommit(): void
  commit(ids: ReadonlySet<NodeId>): void
  clearPreview(): void
  error(error: unknown): void
  /** The erasing pointer's path, drawn by the view as a trail that consumes itself. */
  trail?(point: RealSample): void
}

class EraserGesture implements GestureOwner {
  readonly kind = 'erase' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly queue: SweepQueue
  private readonly release: () => void
  private readonly controller = new AbortController()
  private unregister: (() => void) | null = null
  private last: RealSample
  private ended = false
  private cancelled = false
  private moved = false
  constructor(sample: RealSample, modifiers: Modifiers, private readonly context: EraserContext) {
    this.pointerIds = new Set([sample.pointerId])
    this.last = sample
    this.release = context.hold()
    this.queue = new SweepQueue(context)
    try { this.collect(sample, modifiers) }
    catch (error) { try { this.queue.cancel() } finally { this.release() }; throw error }
  }
  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.collect(sample, modifiers)
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    try { this.unregister = this.context.registerPending(() => this.cancel()) }
    catch (error) {
      this.cancelled = true
      try { this.queue.cancel(); this.context.clearPreview() } finally { this.release() }
      throw error
    }
    void this.queue.finish().then(async ids => {
      if (this.cancelled || !ids.size) return
      await this.context.prepareCommit(ids, this.controller.signal)
      if (this.cancelled || this.controller.signal.aborted) return
      this.context.armCommit()
      try { this.context.commit(ids); this.context.finishCommit() }
      catch (error) { this.context.cancelCommit(); throw error }
    }).catch(error => {
      if (!this.cancelled) this.context.error(error)
    }).finally(() => {
      try { this.unregister?.() } finally {
        this.unregister = null
        try { this.context.clearPreview() } finally { this.release() }
      }
    })
  }
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true; this.controller.abort()
    try { this.queue.cancel() } finally {
      try { this.context.clearPreview() } finally {
        if (!this.ended) { this.ended = true; this.release() }
      }
    }
  }
  private collect(point: RealSample, modifiers: Modifiers): void {
    const from = this.last
    this.last = point
    if (from !== point) {
      // The first move starts the trail at the press point; every later move adds only its own point.
      if (!this.moved) { this.moved = true; this.context.trail?.(from) }
      this.context.trail?.(point)
    }
    this.queue.add(from, point, modifiers.accel)
  }
}
export const eraserTool: Tool<EraserContext> = {
  id: 'eraser', begin: (sample, modifiers, context) => new EraserGesture(sample, modifiers, context),
}

export interface LaserPoint extends InkPoint { readonly time: number }
export interface LaserContext {
  append(point: LaserPoint): void
  finish(): void
  cancel(): void
}
class LaserGesture implements GestureOwner {
  readonly kind = 'laser' as const
  readonly pointerIds: ReadonlySet<number>
  private ended = false
  constructor(sample: RealSample, private readonly context: LaserContext) {
    this.pointerIds = new Set([sample.pointerId]); context.append(sample)
  }
  update(samples: readonly RealSample[]): void {
    if (!this.ended) for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.context.append(sample)
  }
  finish(): void { if (!this.ended) { this.ended = true; this.context.finish() } }
  cancel(): void { if (!this.ended) { this.ended = true; this.context.cancel() } }
}
export const laserTool: Tool<LaserContext> = {
  id: 'laser', begin: (sample, _modifiers, context) => new LaserGesture(sample, context),
}

export interface HandContext {
  toSurface(sample: RealSample): InkPoint
  panBy(delta: InkPoint): void
  invalidate(): void
  flingEnabled?: boolean
  startFling?(samples: readonly TouchPanSample[]): void
}
class HandGesture implements GestureOwner {
  readonly kind = 'pan' as const
  readonly pointerIds: ReadonlySet<number>
  private last: InkPoint
  private ended = false
  private readonly fling = new PanFlingSamples()
  private readonly canFling: boolean
  constructor(sample: RealSample, private readonly context: HandContext) {
    this.pointerIds = new Set([sample.pointerId]); this.last = sampleSurface(sample, context.toSurface)
    this.canFling = context.flingEnabled ?? sample.source === 'touch'
    if (this.canFling) this.fling.append(sample, this.last)
  }
  update(samples: readonly RealSample[]): void {
    if (this.ended) return
    for (const sample of samples) {
      if (!this.pointerIds.has(sample.pointerId)) continue
      const point = sampleSurface(sample, this.context.toSurface)
      this.context.panBy({ x: this.last.x - point.x, y: this.last.y - point.y })
      this.last = point
      if (this.canFling) this.fling.append(sample, point)
    }
    if (samples.length) this.context.invalidate()
  }
  finish(reason: FinishReason): void {
    if (this.ended) return
    this.ended = true
    if (reason === 'up' && this.canFling) this.context.startFling?.(this.fling.release())
    else this.fling.clear()
  }
  cancel(): void { this.ended = true; this.fling.clear() }
}
export const handTool: Tool<HandContext> = {
  id: 'hand', begin: (sample, _modifiers, context) => new HandGesture(sample, context),
}
