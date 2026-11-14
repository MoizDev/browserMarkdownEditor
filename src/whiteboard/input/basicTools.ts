import type { GestureOwner, Modifiers, RealSample, Tool } from './tool'

export interface InkPoint { readonly x: number; readonly y: number }
export interface EraserContext {
  // The shared hierarchy/pick service applies locks and parent/group policy.
  sweep(from: InkPoint, to: InkPoint, topOnly: boolean): readonly string[]
  preview(ids: ReadonlySet<string>): void
  commit(ids: ReadonlySet<string>): void
  clearPreview(): void
}

class EraserGesture implements GestureOwner {
  readonly kind = 'erase' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly ids = new Set<string>()
  private last: InkPoint
  private ended = false
  constructor(sample: RealSample, modifiers: Modifiers, private readonly context: EraserContext) {
    this.pointerIds = new Set([sample.pointerId])
    this.last = sample
    this.collect(sample, modifiers)
  }
  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.collect(sample, modifiers)
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    try { if (this.ids.size) this.context.commit(this.ids) } finally { this.context.clearPreview() }
  }
  cancel(): void { if (!this.ended) { this.ended = true; this.context.clearPreview() } }
  private collect(point: InkPoint, modifiers: Modifiers): void {
    for (const id of this.context.sweep(this.last, point, modifiers.accel)) this.ids.add(id)
    this.last = point
    this.context.preview(this.ids)
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
