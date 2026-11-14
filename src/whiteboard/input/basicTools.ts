import type { GestureOwner, Modifiers, RealSample, Tool } from './tool'
import type { NodeId } from '../model/ids'
import { SweepQueue, type SweepQueueServices } from './sweepQueue'

export interface InkPoint { readonly x: number; readonly y: number }
export interface EraserContext extends SweepQueueServices {
  hold(): () => void
  registerPending(cancel: () => void): () => void
  commit(ids: ReadonlySet<NodeId>): void
  clearPreview(): void
  error(error: unknown): void
}

class EraserGesture implements GestureOwner {
  readonly kind = 'erase' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly queue: SweepQueue
  private readonly release: () => void
  private unregister: (() => void) | null = null
  private last: InkPoint
  private ended = false
  private cancelled = false
  constructor(sample: RealSample, modifiers: Modifiers, private readonly context: EraserContext) {
    this.pointerIds = new Set([sample.pointerId])
    this.last = sample
    this.release = context.hold()
    this.queue = new SweepQueue(context)
    this.collect(sample, modifiers)
  }
  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.collect(sample, modifiers)
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    this.unregister = this.context.registerPending(() => this.cancel())
    void this.queue.finish().then(ids => {
      if (!this.cancelled && ids.size) this.context.commit(ids)
    }).catch(error => {
      if (!this.cancelled) this.context.error(error)
    }).finally(() => { this.unregister?.(); this.unregister = null; this.context.clearPreview(); this.release() })
  }
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.queue.cancel()
    this.context.clearPreview()
    if (!this.ended) { this.ended = true; this.release() }
  }
  private collect(point: InkPoint, modifiers: Modifiers): void {
    const from = this.last
    this.last = point
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
}
class HandGesture implements GestureOwner {
  readonly kind = 'pan' as const
  readonly pointerIds: ReadonlySet<number>
  private last: InkPoint
  private ended = false
  constructor(sample: RealSample, private readonly context: HandContext) {
    this.pointerIds = new Set([sample.pointerId]); this.last = context.toSurface(sample)
  }
  update(samples: readonly RealSample[]): void {
    if (this.ended) return
    for (const sample of samples) {
      if (!this.pointerIds.has(sample.pointerId)) continue
      const point = this.context.toSurface(sample)
      this.context.panBy({ x: this.last.x - point.x, y: this.last.y - point.y })
      this.last = point
    }
    if (samples.length) this.context.invalidate()
  }
  finish(): void { this.ended = true }
  cancel(): void { this.ended = true }
}
export const handTool: Tool<HandContext> = {
  id: 'hand', begin: (sample, _modifiers, context) => new HandGesture(sample, context),
}
