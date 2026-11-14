import { cameraAtAnchor, surfaceToWorld, type CameraController, type Point } from '../../platform/render/camera'

export interface ContactPoint extends Point {
  readonly id: number
  readonly time: number
  readonly width: number
  readonly height: number
}

export interface TouchActions {
  cancelTouchPreview(): void
  endTouchCamera(): void
  changed(): void
  penModeChanged(enabled: boolean): void
}

interface TouchContact { point: ContactPoint; eligible: boolean }
interface Pinch { ids: [number, number]; distance: number; zoom: number; anchor: Point }

// Contact identity survives suppression: a palm held through pen-up is never promoted.
export class TouchArbiter {
  private readonly touches = new Map<number, TouchContact>()
  private readonly pens = new Set<number>()
  private mode = false
  private lastPenUp = -Infinity
  private hoverTime = -Infinity
  private pinch: Pinch | null = null
  private pendingPair: [number, number] | null = null
  private pan: { id: number; point: Point } | null = null

  constructor(private readonly camera: CameraController, private readonly actions: TouchActions, initialPenMode = false) { this.mode = initialPenMode }
  get penMode(): boolean { return this.mode }
  setPenMode(enabled: boolean): void { if (this.mode !== enabled) { this.mode = enabled; this.actions.penModeChanged(enabled) } }
  exitPenMode(): void { this.setPenMode(false) }
  penHover(time: number): void { this.hoverTime = time }
  penDown(id: number, directTouchDevice: boolean): void {
    if (directTouchDevice) this.setPenMode(true)
    if (!this.pens.size) {
      this.actions.cancelTouchPreview()
      if (this.pinch || this.pan) this.actions.endTouchCamera()
      this.pinch = null; this.pendingPair = null; this.pan = null
      for (const touch of this.touches.values()) touch.eligible = false
    }
    this.pens.add(id)
  }
  penUp(id: number, time: number): void { if (this.pens.delete(id) && !this.pens.size) this.lastPenUp = time }

  // Returns true only when the touch may start authoring; camera contacts are managed here.
  touchDown(point: ContactPoint): boolean {
    if (this.touches.has(point.id)) return false
    const large = Math.max(point.width, point.height) > 30
    const recentPen = point.time - this.lastPenUp < 300 || point.time - this.hoverTime < 100
    const eligible = !this.pens.size && !(large && recentPen)
    this.touches.set(point.id, { point, eligible })
    if (!eligible) return false
    const qualified = [...this.touches.values()].filter(t => t.eligible)
    if (qualified.length === 2 && !this.pinch) {
      this.actions.cancelTouchPreview()
      this.beginPinch(qualified[0].point, qualified[1].point)
      return false
    }
    return qualified.length === 1 && !this.mode && !this.pan
  }

  touchMove(point: ContactPoint): void {
    const touch = this.touches.get(point.id)
    if (!touch) return
    touch.point = point
    if (this.pendingPair?.includes(point.id)) {
      const a = this.touches.get(this.pendingPair[0])?.point
      const b = this.touches.get(this.pendingPair[1])?.point
      if (a && b) this.beginPinch(a, b)
    }
    if (this.pinch && this.pinch.ids.includes(point.id)) {
      const a = this.touches.get(this.pinch.ids[0])?.point
      const b = this.touches.get(this.pinch.ids[1])?.point
      if (!a || !b) return
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (distance < 8) return
      const centroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const z = this.camera.clampZoom(this.pinch.zoom * distance / this.pinch.distance)
      this.camera.setCamera(cameraAtAnchor(this.pinch.anchor, centroid, z))
      this.actions.changed()
    } else if (this.pan?.id === point.id) {
      this.camera.panBy({ x: this.pan.point.x - point.x, y: this.pan.point.y - point.y })
      this.pan.point = point
      this.actions.changed()
    }
  }

  touchUp(id: number): void {
    this.touches.delete(id)
    if (this.pendingPair?.includes(id)) { this.pendingPair = null; this.actions.endTouchCamera() }
    if (this.pinch?.ids.includes(id)) {
      this.pinch = null
      const remaining = [...this.touches.values()].filter(t => t.eligible)
      if (remaining.length >= 2) this.beginPinch(remaining[0].point, remaining[1].point)
      else if (remaining.length === 1) this.pan = { id: remaining[0].point.id, point: remaining[0].point }
      else this.actions.endTouchCamera()
    } else if (this.pan?.id === id) { this.pan = null; this.actions.endTouchCamera() }
  }

  private beginPinch(a: ContactPoint, b: ContactPoint): void {
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    if (distance < 8) { this.pendingPair = [a.id, b.id]; return }
    this.pendingPair = null
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    this.pan = null
    this.pinch = { ids: [a.id, b.id], distance, zoom: this.camera.camera.z, anchor: surfaceToWorld(centre, this.camera.camera) }
  }
}

export interface WheelAdapterOptions {
  readonly camera: CameraController
  readonly paged: boolean
  readonly toSurface: (x: number, y: number) => Point
  readonly owns: (event: WheelEvent) => boolean
  readonly changed: () => void
}

export function installWheel(root: HTMLElement, options: WheelAdapterOptions): () => void {
  const wheel = (event: WheelEvent): void => {
    if (!options.owns(event) || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY) || (!event.deltaX && !event.deltaY)) return
    const mode = event.deltaMode === 1 ? 'line' : event.deltaMode === 2 ? 'page' : 'pixel'
    if (event.ctrlKey || event.metaKey) {
      const unit = mode === 'line' ? 16 : mode === 'page' ? options.camera.viewport.height : 1
      options.camera.zoomWheel(event.deltaY * unit, options.toSurface(event.clientX, event.clientY))
    } else {
      options.camera.panWheel({ deltaX: options.paged ? 0 : event.deltaX, deltaY: event.deltaY, deltaMode: mode, shift: !options.paged && event.shiftKey })
    }
    event.preventDefault(); event.stopPropagation(); options.changed()
  }
  root.addEventListener('wheel', wheel, { passive: false })
  return () => { root.removeEventListener('wheel', wheel) }
}
