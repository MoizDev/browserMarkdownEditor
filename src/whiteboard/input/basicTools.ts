import { sampleSurface, type CancelReason, type FinishReason, type GestureOwner, type Modifiers, type RealSample, type Tool } from './tool'
import type { TouchPanSample } from '../../platform/render/scheduler'
import { PanFlingSamples } from './panFling'
import type { NodeId } from '../model/ids'
import { EraseSweep, type ErasePoint } from './eraseSweep'

export interface InkPoint { readonly x: number; readonly y: number }
export function eraserRadiusCss(source: RealSample['source']): number { return source === 'touch' ? 12 : 8 }
export interface EraseStep {
  erase(ids: readonly NodeId[], signal: AbortSignal): void | Promise<void>
  release(): void
  latest(): boolean
  close(): void
  revert(): void
}
export interface EraserContext {
  hold(): () => void
  settle(): () => void
  registerSettling(cancel: (undo: boolean) => boolean | void, undoable: boolean): () => void
  touched(points: readonly ErasePoint[], radiusCss: number, signal: AbortSignal): Promise<readonly NodeId[]>
  beginErase(): EraseStep
  eraseTurn(): { readonly ready: Promise<void>; done(): void }
  now(): number
  wait(ms: number): Promise<void>
  error(error: unknown): void
  trail?(point: RealSample, radiusCss: number): void
}

class EraserGesture implements GestureOwner {
  readonly kind = 'erase' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly sweep: EraseSweep
  private readonly step: EraseStep
  private readonly turn: { readonly ready: Promise<void>; done(): void }
  private readonly radius: number
  private release: () => void
  private unregister: (() => void) | null = null
  private last: RealSample
  private ended = false
  private over = false
  private moved = false
  constructor(sample: RealSample, modifiers: Modifiers, private readonly context: EraserContext) {
    this.pointerIds = new Set([sample.pointerId])
    this.last = sample
    this.radius = eraserRadiusCss(sample.source)
    this.release = context.hold()
    let turn: { readonly ready: Promise<void>; done(): void } | undefined
    try {
      this.turn = turn = context.eraseTurn()
      const step = this.step = context.beginErase()
      this.sweep = new EraseSweep({
        touched: (points, signal) => context.touched(points, this.radius, signal),
        erase: (ids, signal) => step.erase(ids, signal),
        turn: turn.ready, now: context.now, wait: context.wait, error: context.error,
      })
      this.sweep.add(sample, modifiers.accel)
    } catch (error) { try { turn?.done() } finally { this.release() }; throw error }
  }
  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.collect(sample, modifiers)
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    if (this.sweep.idle) { this.end(false); return }
    let settle: (() => void) | null = null
    try {
      settle = this.context.settle()
      this.unregister = this.context.registerSettling(undo => { if (undo && !this.step.latest()) return false; this.end(undo); return true }, true)
    } catch (error) {
      try { settle?.() } finally { this.end(false) }
      throw error
    }
    try { this.step.release() } catch (error) { this.context.error(error) }
    const input = this.release
    this.release = settle
    input()
    void this.sweep.finish().then(() => this.end(false))
  }
  cancel(reason?: CancelReason): void {
    this.ended = true
    this.end(reason === 'escape' || reason === 'undo')
  }
  discard(): void { this.ended = true; this.end(true) }
  private end(revert: boolean): void {
    if (this.over) return
    this.over = true
    this.sweep.stop()
    try { this.unregister?.() } finally {
      this.unregister = null
      try { if (revert) this.step.revert(); else this.step.close() }
      catch (error) { this.context.error(error) }
      finally { try { this.turn.done() } finally { this.release() } }
    }
  }
  private collect(point: RealSample, modifiers: Modifiers): void {
    const from = this.last
    this.last = point
    if (from !== point) {
      if (!this.moved) { this.moved = true; this.context.trail?.(from, this.radius) }
      this.context.trail?.(point, this.radius)
    }
    this.sweep.add(point, modifiers.accel)
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
