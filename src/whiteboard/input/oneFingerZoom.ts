import { CLICK_SLOP_CSS, type GestureOwner, type RealSample, type Tool } from './tool'

export interface OneFingerZoomContext {
  toSurface(sample: RealSample): { readonly x: number; readonly y: number }
  zoomNow(): number
  /** Live, unanimated zoom while the finger drags. */
  zoomTo(z: number, anchor: { readonly x: number; readonly y: number }): void
  /** A release without a drag: one zoom step in, animated. */
  zoomIn(anchor: { readonly x: number; readonly y: number }): void
  clamp(z: number): number
}

/** Double tap and hold, then drag on touch: up zooms out, down zooms in, 200 px is a doubling, anchored at the press
 * point (catalogue T§2, OneFingerZooming). A release that never left the slop is the double tap's one step instead. */
const PX_PER_DOUBLING = 200;
class OneFingerZoomGesture implements GestureOwner {
  readonly kind = 'pan' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly origin: { readonly x: number; readonly y: number }
  private readonly startZoom: number
  private moved = false
  private ended = false
  constructor(sample: RealSample, private readonly context: OneFingerZoomContext) {
    this.pointerIds = new Set([sample.pointerId])
    this.origin = context.toSurface(sample)
    this.startZoom = context.zoomNow()
  }
  update(samples: readonly RealSample[]): void {
    if (this.ended) return
    for (const sample of samples) {
      if (!this.pointerIds.has(sample.pointerId)) continue
      const point = this.context.toSurface(sample)
      if (!this.moved && Math.hypot(point.x - this.origin.x, point.y - this.origin.y) > CLICK_SLOP_CSS) this.moved = true
      if (this.moved) this.context.zoomTo(this.context.clamp(this.startZoom * 2 ** ((point.y - this.origin.y) / PX_PER_DOUBLING)), this.origin)
    }
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    if (!this.moved) this.context.zoomIn(this.origin)
  }
  cancel(): void { this.ended = true }
}
export const oneFingerZoomTool = (context: OneFingerZoomContext): Tool<unknown> => ({
  id: 'one-finger-zoom', begin: sample => new OneFingerZoomGesture(sample, context),
})
