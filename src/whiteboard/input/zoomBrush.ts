import { sampleSurface, type GestureOwner, type Modifiers, type RealSample, type Tool } from './tool'

export interface ZoomPoint { readonly x: number; readonly y: number }
export interface ZoomBox extends ZoomPoint { readonly width: number; readonly height: number }
export interface ZoomCamera { readonly x: number; readonly y: number; readonly z: number }
export interface ZoomBrushContext {
  toSurface(sample: RealSample): ZoomPoint
  preview(box: ZoomBox): void
  clearPreview(): void
  fitBox(box: ZoomBox, cap?: number): void
  stepZoom(direction: -1 | 1, point: ZoomPoint): void
  view(): { readonly camera: ZoomCamera; readonly viewport: { readonly width: number; readonly height: number } }
  setCamera(camera: ZoomCamera): void
  clampZoom(z: number): number
  prepareOverview?(): void
  overviewBox?(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
}

const BRUSH_MIN_PX = 8

class ZoomBrushGesture implements GestureOwner {
  readonly kind = 'zoom-brush' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly start: ZoomPoint
  private point: ZoomPoint
  private alt: boolean
  private ended = false
  constructor(sample: RealSample, modifiers: Modifiers, private readonly context: ZoomBrushContext) {
    this.pointerIds = new Set([sample.pointerId])
    this.start = sampleSurface(sample, context.toSurface); this.point = this.start; this.alt = modifiers.alt
  }
  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    this.alt = modifiers.alt
    for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.point = sampleSurface(sample, this.context.toSurface)
    this.context.preview(this.box())
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    try {
      const box = this.box()
      if (box.width >= BRUSH_MIN_PX && box.height >= BRUSH_MIN_PX) this.context.fitBox(box, this.alt ? 0.5 : undefined)
      else this.context.stepZoom(this.alt ? -1 : 1, this.point)
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
