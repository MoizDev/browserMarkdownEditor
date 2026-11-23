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
/** Two fingers start undecided. Each threshold is measured from the pair's start, so a finger that only drifts stays a pan
 * until the midpoint moves 16 px, and a pinch is a zoom only after the spacing changes 24 px. Once panning, the spacing must
 * change 64 px before the gesture becomes a zoom: a two-finger pan does not zoom by accident. Measured in CSS px (catalogue I§4.2). */
const PINCH_ZOOM_START_PX = 24, PINCH_PAN_START_PX = 16, PINCH_ZOOM_FROM_PAN_PX = 64, PINCH_MIN_SPACING_PX = 8;
interface Pinch { ids: [number, number]; distance: number; zoom: number; anchor: Point; mid: Point; start: Point; mode: 'undecided' | 'panning' | 'zooming' }

// Contact identity survives suppression: a palm held through pen-up is never promoted.
export class TouchArbiter {
  private readonly touches = new Map<number, TouchContact>()
  private readonly pens = new Set<number>()
  private mode = false
  private pinch: Pinch | null = null
  private pendingPair: [number, number] | null = null
  private pan: { id: number; point: Point } | null = null

  constructor(private readonly camera: CameraController, private readonly actions: TouchActions, initialPenMode = false) { this.mode = initialPenMode }
  get penMode(): boolean { return this.mode }
  setPenMode(enabled: boolean): void { if (this.mode !== enabled) { this.mode = enabled; this.actions.penModeChanged(enabled) } }
  exitPenMode(): void { this.setPenMode(false) }
  penHover(): void {}
  penDown(id: number, directTouchDevice: boolean): void {
    const first = !this.pens.size, hadCamera = !!(this.pinch || this.pendingPair || this.pan)
    this.pens.add(id)
    try {
      if (first) {
        this.pinch = null; this.pendingPair = null; this.pan = null
        for (const touch of this.touches.values()) touch.eligible = false
        try { this.actions.cancelTouchPreview() } finally { if (hadCamera) this.actions.endTouchCamera() }
      }
    } finally { if (directTouchDevice) this.setPenMode(true) }
  }
  penUp(id: number): void { this.pens.delete(id) }

  // Returns true only when the touch may start authoring; camera contacts are managed here.
  // Admission is by contact lifetime and pen state alone (F-INPUT-007): a contact that began during pen contact
  // was already marked ineligible in penDown, and a fresh contact after pen-up is not second-guessed by its size or timing.
  touchDown(point: ContactPoint): boolean {
    if (this.touches.has(point.id)) return false
    const eligible = !this.pens.size
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
      const pinch = this.pinch
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (distance < PINCH_MIN_SPACING_PX) return
      const centroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const spacing = Math.abs(distance - pinch.distance), drift = Math.hypot(centroid.x - pinch.start.x, centroid.y - pinch.start.y)
      if (pinch.mode === 'undecided') {
        if (spacing > PINCH_ZOOM_START_PX) pinch.mode = 'zooming'
        else if (drift > PINCH_PAN_START_PX) pinch.mode = 'panning'
      } else if (pinch.mode === 'panning' && spacing > PINCH_ZOOM_FROM_PAN_PX) pinch.mode = 'zooming'
      if (pinch.mode === 'panning') {
        this.camera.panBy({ x: pinch.mid.x - centroid.x, y: pinch.mid.y - centroid.y })
        pinch.mid = centroid
        this.actions.changed()
      } else if (pinch.mode === 'zooming') {
        const z = this.camera.clampZoom(pinch.zoom * distance / pinch.distance)
        this.camera.setCamera(cameraAtAnchor(pinch.anchor, centroid, z))
        this.actions.changed()
      }
    } else if (this.pan?.id === point.id) {
      this.camera.panBy({ x: this.pan.point.x - point.x, y: this.pan.point.y - point.y })
      this.pan.point = point
      this.actions.changed()
    }
  }

  touchUp(id: number): void {
    this.touches.delete(id)
    if (this.pendingPair?.includes(id)) {
      this.pendingPair = null
      const remaining = [...this.touches.values()].filter(t => t.eligible)
      if (remaining.length >= 2) this.beginPinch(remaining[0].point, remaining[1].point)
      else this.actions.endTouchCamera()
    }
    if (this.pinch?.ids.includes(id)) {
      this.pinch = null
      const remaining = [...this.touches.values()].filter(t => t.eligible)
      if (remaining.length >= 2) this.beginPinch(remaining[0].point, remaining[1].point)
      else if (remaining.length === 1 && !this.mode) this.pan = { id: remaining[0].point.id, point: remaining[0].point }
      else this.actions.endTouchCamera()
    } else if (this.pan?.id === id) { this.pan = null; this.actions.endTouchCamera() }
  }

  private beginPinch(a: ContactPoint, b: ContactPoint): void {
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    if (distance < PINCH_MIN_SPACING_PX) { this.pendingPair = [a.id, b.id]; return }
    this.pendingPair = null
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    this.pan = null
    this.pinch = { ids: [a.id, b.id], distance, zoom: this.camera.camera.z, anchor: surfaceToWorld(centre, this.camera.camera), mid: centre, start: centre, mode: 'undecided' }
  }
}

export interface WheelAdapterOptions {
  readonly camera: CameraController
  readonly paged: boolean
  readonly toSurface: (x: number, y: number) => Point
  readonly owns: (event: WheelEvent) => boolean
  readonly changed: () => void
  /** Preferences: a mouse wheel's zoom turn reverses. Panning never reverses. */
  readonly invertZoom?: () => boolean
  /** Input device preference: true when the mouse is chosen, so a plain wheel turn zooms; Auto and Trackpad pan. */
  readonly mouseWheel?: () => boolean
}

/** A wheel turn zooms by at most 10% (catalogue I§3.2): raw deltas clamp to ±10 and each unit is 1/100 of the zoom. A notch
 * from a mouse is 100 px, so an unclamped turn zoomed ×1.65 per notch. Ctrl/Cmd swaps the device's behaviour, so a trackpad
 * pinch (which arrives as Ctrl+wheel) zooms while the trackpad pans. */
const WHEEL_ZOOM_STEP_CLAMP = 10, WHEEL_ZOOM_STEP_DIVISOR = 100

export function installWheel(root: HTMLElement, options: WheelAdapterOptions): () => void {
  const wheel = (event: WheelEvent): void => {
    if (!options.owns(event) || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY) || (!event.deltaX && !event.deltaY)) return
    const mode = event.deltaMode === 1 ? 'line' : event.deltaMode === 2 ? 'page' : 'pixel'
    const zooms = (event.ctrlKey || event.metaKey) !== (options.mouseWheel?.() ?? false)
    if (zooms) {
      const turn = Math.max(-WHEEL_ZOOM_STEP_CLAMP, Math.min(WHEEL_ZOOM_STEP_CLAMP, event.deltaY)) / WHEEL_ZOOM_STEP_DIVISOR
      const direction = options.invertZoom?.() ? -1 : 1
      const anchor = options.toSurface(event.clientX, event.clientY)
      options.camera.zoomTo(options.camera.camera.z * (1 - direction * turn), anchor)
    } else {
      options.camera.panWheel({ deltaX: options.paged ? 0 : event.deltaX, deltaY: event.deltaY, deltaMode: mode, shift: !options.paged && event.shiftKey })
    }
    event.preventDefault(); event.stopPropagation(); options.changed()
  }
  root.addEventListener('wheel', wheel, { passive: false })
  return () => { root.removeEventListener('wheel', wheel) }
}
