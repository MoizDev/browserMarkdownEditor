import type { GestureOwner, Modifiers, RealSample, Tool } from './tool'

export interface ZoomPoint { readonly x: number; readonly y: number }
export interface ZoomBox extends ZoomPoint { readonly width: number; readonly height: number }
export interface ZoomBrushContext {
  toSurface(sample: RealSample): ZoomPoint
  preview(box: ZoomBox): void
  clearPreview(): void
  fitBox(box: ZoomBox): void
  zoomAt(point: ZoomPoint, factor: number): void
}

class ZoomBrushGesture implements GestureOwner {
  readonly kind = 'zoom-brush' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly start: ZoomPoint
  private point: ZoomPoint
  private alt: boolean
  private ended = false
  constructor(sample: RealSample, modifiers: Modifiers, private readonly context: ZoomBrushContext) {
    this.pointerIds = new Set([sample.pointerId])
    this.start = context.toSurface(sample); this.point = this.start; this.alt = modifiers.alt
  }
  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    this.alt = modifiers.alt
    for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.point = this.context.toSurface(sample)
    this.context.preview(this.box())
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    try {
      const box = this.box()
      if (this.alt) this.context.zoomAt(this.point, 0.5)
      else if (box.width >= 4 && box.height >= 4) this.context.fitBox(box)
      else this.context.zoomAt(this.point, 2)
    } finally { this.context.clearPreview() }
  }
  cancel(): void { if (!this.ended) { this.ended = true; this.context.clearPreview() } }
  private box(): ZoomBox {
    return { x: Math.min(this.start.x, this.point.x), y: Math.min(this.start.y, this.point.y),
      width: Math.abs(this.point.x - this.start.x), height: Math.abs(this.point.y - this.start.y) }
  }
}
export const zoomBrushTool: Tool<ZoomBrushContext> = {
  id: 'zoom', begin: (sample, modifiers, context) => new ZoomBrushGesture(sample, modifiers, context),
}
