import { sampleSurface, type CancelReason, type FinishReason, type GestureOwner, type Modifiers, type RealSample, type Tool } from './tool'
import type { TouchPanSample } from '../../platform/render/scheduler'
import { PanFlingSamples } from './panFling'
import type { NodeId } from '../model/ids'
import { EraseSweep, type ErasePoint } from './eraseSweep'

export interface InkPoint { readonly x: number; readonly y: number }
/** The eraser's reach around the pointer, in CSS px: the same on screen at every zoom, so it is what the eraser's ring and
 * trail show. A finger is wider than a pen tip or a mouse pointer and cannot be seen under itself, so its reach is wider. */
export function eraserRadiusCss(source: RealSample['source']): number { return source === 'touch' ? 12 : 8 }
/** One erase gesture's undo step. Items leave the board as the eraser reaches them, and all of them are one step. */
export interface EraseStep {
  erase(ids: readonly NodeId[], signal: AbortSignal): void | Promise<void>
  /** The pointer has lifted while the last stretch of the path is still to be asked: what went so far is an undo step from
   * now, and what the rest takes joins that step for as long as it is the latest one. */
  release(): void
  /** After `release`: whether an undo now would take back this erase, nothing else having been done since. */
  latest(): boolean
  /** The gesture is over: what it erased is one undo step (none, if it erased nothing). */
  close(): void
  /** The gesture is taken back: everything it erased returns, and it leaves no undo step. */
  revert(): void
}
export interface EraserContext {
  hold(): () => void
  /** The hold a released erase keeps while the last stretch of its path is still being asked: it orders queued edits and
   * commands after the erase, but does not refuse the person's next press (a `settling` gesture hold). */
  settle(): () => void
  /** Released work still landing: a new press, Escape, a tool change or another key does not cancel it. An undo
   * (`undo` true) takes it back; the view's end (`undo` false) only stops it. */
  /** `cancel` answers false when asked to undo work that is no longer the latest: the undo is then not its own. */
  registerSettling(cancel: (undo: boolean) => boolean | void, undoable: boolean): () => void
  /** The items a stretch of the eraser's path touches (world points, `radiusCss` around them) on the board as it is now,
   * bottom-most first. */
  touched(points: readonly ErasePoint[], radiusCss: number, signal: AbortSignal): Promise<readonly NodeId[]>
  beginErase(): EraseStep
  /** Resolves once the erase released before this one has finished; `done` ends this one's turn. */
  eraseTurn(): { readonly ready: Promise<void>; done(): void }
  now(): number
  wait(ms: number): Promise<void>
  error(error: unknown): void
  /** The erasing pointer's path and reach, drawn by the view as a trail that consumes itself. */
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
      // The press itself erases what is under it: a tap is an erase, and a drag starts erasing where it was pressed.
      this.sweep.add(sample, modifiers.accel)
    } catch (error) { try { turn?.done() } finally { this.release() }; throw error }
  }
  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.collect(sample, modifiers)
  }
  // A release leaves at most the last stretch of the path still to ask (a few ms; nothing at all when the pointer rested
  // before lifting), so the erase is usually whole and one undo step before this returns. While that stretch is asked the
  // erase is released work: it lands, the next press is admitted, and only an undo takes it back.
  finish(): void {
    if (this.ended) return
    this.ended = true
    if (this.sweep.idle) { this.end(false); return }
    let settle: (() => void) | null = null
    try {
      settle = this.context.settle()
      // An undo while the last stretch lands takes this erase back only while it is the latest thing done. After a stroke
      // drawn since, the undo is that stroke's: this erase goes on landing and declines (false).
      this.unregister = this.context.registerSettling(undo => { if (undo && !this.step.latest()) return false; this.end(undo); return true }, true)
    } catch (error) {
      try { settle?.() } finally { this.end(false) }
      throw error
    }
    // The step is closed before the input is given back: whatever the person does next is its own step (see beginErase).
    try { this.step.release() } catch (error) { this.context.error(error) }
    const input = this.release
    this.release = settle
    input()
    void this.sweep.finish().then(() => this.end(false))
  }
  // Escape and Undo take the gesture back whole. Any other end (the view going away, the pointer cancelled by the system, a
  // tool change) stops it and keeps what it erased: the person saw those items go, and one undo brings them back.
  cancel(reason?: CancelReason): void {
    this.ended = true
    this.end(reason === 'escape' || reason === 'undo')
  }
  /** A finger that turned out to be the first of a pinch never meant to erase. */
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
      // The first move starts the trail at the press point; every later move adds only its own point.
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
