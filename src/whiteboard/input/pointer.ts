import { CLICK_SLOP_CSS, MULTI_CLICK_CSS, MULTI_CLICK_MS, type Modifiers, type RealSample } from './tool'

export interface PresentedMapping {
  readonly time: number
  clientToWorld(x: number, y: number): { readonly x: number; readonly y: number }
  clientToSurface(x: number, y: number): { readonly x: number; readonly y: number }
}

/** Freeze the DOM rectangle and camera from one actually presented frame. */
export function presentedMapping(time: number,
  rect: Readonly<{ left: number; top: number; width: number; height: number }>,
  viewport: Readonly<{ width: number; height: number }>,
  camera: Readonly<{ x: number; y: number; z: number }>): PresentedMapping {
  const { left, top, width, height } = rect, { width: vw, height: vh } = viewport, { x, y, z } = camera
  if (![time, left, top, width, height, vw, vh, x, y, z].every(Number.isFinite)
    || time < 0 || width <= 0 || height <= 0 || vw <= 0 || vh <= 0 || z <= 0) throw new RangeError('Invalid presented mapping geometry')
  const sx = vw / width, sy = vh / height
  const clientToSurface = (clientX: number, clientY: number) => ({ x: (clientX - left) * sx, y: (clientY - top) * sy })
  return Object.freeze({ time, clientToSurface, clientToWorld(clientX: number, clientY: number) {
    const point = clientToSurface(clientX, clientY)
    return { x: x + point.x / z, y: y + point.y / z }
  } })
}

// Record mappings only after presentation, not when a future camera is scheduled.
export class MappingHistory {
  private entries: PresentedMapping[] = []
  /** `shown`: the view has presented a frame since it was last shown (its owner knows; hiding forgets the frame). */
  constructor(private readonly onExpired: () => void = () => {}, private readonly shown: () => boolean = () => true) {}
  /** A new press can be placed: there is a presented frame of this showing to place it with. */
  ready(): boolean { return this.entries.length > 0 && this.shown() }
  present(mapping: PresentedMapping): void {
    if (!Number.isFinite(mapping.time) || typeof mapping.clientToWorld !== 'function' || typeof mapping.clientToSurface !== 'function'
      || (this.entries.length && mapping.time < this.entries[this.entries.length - 1].time)) throw new Error('Invalid presented input mapping')
    this.entries.push(mapping)
    // Retain at least 250 ms even at very high frame rates.
    while (this.entries.length > 64 && mapping.time - this.entries[1].time >= 250) this.entries.shift()
  }
  private at(time: number): PresentedMapping {
    if (!this.entries.length) throw new Error('No presented input mapping')
    let i = this.entries.length - 1
    while (i > 0 && this.entries[i].time > time) i--
    if (time < this.entries[0].time) this.onExpired()
    return this.entries[i]
  }
  latest(): PresentedMapping | null { return this.entries[this.entries.length - 1] ?? null }
  map(time: number, x: number, y: number): { readonly x: number; readonly y: number } {
    return this.at(time).clientToWorld(x, y)
  }
  surface(time: number, x: number, y: number): { readonly x: number; readonly y: number } {
    return this.at(time).clientToSurface(x, y)
  }
  /** Recover the physical input point through the SAME presented affine that
   * acquired it. Reprojecting with a newer pan camera feeds motion back twice. */
  unmap(time: number, point: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } {
    const mapping = this.at(time), o = mapping.clientToWorld(0, 0), x = mapping.clientToWorld(1, 0), y = mapping.clientToWorld(0, 1)
    const a = x.x - o.x, b = x.y - o.y, c = y.x - o.x, d = y.y - o.y, determinant = a * d - b * c
    if (![a, b, c, d, determinant, point.x, point.y].every(Number.isFinite) || determinant === 0) throw new RangeError('Invalid presented input affine')
    const dx = point.x - o.x, dy = point.y - o.y
    const result = { x: (d * dx - c * dy) / determinant, y: (-b * dx + a * dy) / determinant }
    if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new RangeError('Presented input affine overflows')
    return result
  }
}

export interface PointerSink {
  down(sample: RealSample, modifiers: Modifiers, event: PointerEvent): boolean
  move(pointerId: number, samples: readonly RealSample[], modifiers: Modifiers, event: PointerEvent): void
  up(pointerId: number, samples: readonly RealSample[], modifiers: Modifiers, event: PointerEvent): void
  cancel(pointerId: number, reason: 'cancel' | 'capture-lost' | 'capture-failed'): void
  hover?(event: PointerEvent): void
  captured?(pointerId: number): void
  contextMenu?(event: MouseEvent): void
  error?(error: unknown, pointerId: number): void
}

class PartialPointerBatchError extends Error {
  constructor(readonly samples: readonly RealSample[], readonly failure: unknown) {
    super('Pointer batch stopped after a preserved prefix')
  }
}

interface Contact {
  readonly id: number
  watermark: number
  suffix: string[]
  /** Raw points already delivered since the last pointermove, including equal-time points. */
  rawSinceMove: Map<string, number>
}

function modifiers(event: PointerEvent, mac: boolean): Modifiers {
  return { shift: event.shiftKey, alt: event.altKey, accel: mac ? event.metaKey : event.ctrlKey, control: event.ctrlKey }
}

function tuple(event: PointerEvent): string {
  return [event.timeStamp, event.clientX, event.clientY, event.pressure, event.buttons, event.tiltX, event.tiltY, event.twist].join(',')
}

export class PointerAcquisition {
  private readonly contacts = new Map<number, Contact>()
  private sequence = 0
  /** The last primary press, for counting runs of clicks: a pointerdown's `detail` is always 0 in Chromium, so the board counts
   * them itself. Read from `detail`, a double- or triple-click inside a text being edited never selected a word or a paragraph. */
  private press: { readonly id: number; readonly kind: string; readonly x: number; readonly y: number; readonly time: number; readonly clicks: number; dragged: boolean } | null = null
  private readonly previousTouchAction: string
  private disposed = false

  constructor(private readonly root: HTMLElement, private readonly mappings: MappingHistory, private readonly sink: PointerSink, private readonly mac: boolean) {
    this.previousTouchAction = root.style.touchAction
    root.style.touchAction = 'none'
    root.addEventListener('pointerdown', this.down)
    root.addEventListener('pointermove', this.move)
    root.addEventListener('pointerrawupdate', this.raw as EventListener)
    root.addEventListener('pointerup', this.up)
    root.addEventListener('pointercancel', this.cancel)
    root.addEventListener('gotpointercapture', this.got)
    root.addEventListener('lostpointercapture', this.lost)
    root.addEventListener('pointerover', this.hover)
    root.addEventListener('pointerout', this.hover)
    root.addEventListener('contextmenu', this.menu)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.contacts.keys()]) {
      try { this.end(id, 'capture-lost') } catch (error) { try { this.sink.error?.(error, id) } catch { /* Continue detaching other contacts. */ } }
    }
    this.root.removeEventListener('pointerdown', this.down)
    this.root.removeEventListener('pointermove', this.move)
    this.root.removeEventListener('pointerrawupdate', this.raw as EventListener)
    this.root.removeEventListener('pointerup', this.up)
    this.root.removeEventListener('pointercancel', this.cancel)
    this.root.removeEventListener('gotpointercapture', this.got)
    this.root.removeEventListener('lostpointercapture', this.lost)
    this.root.removeEventListener('pointerover', this.hover)
    this.root.removeEventListener('pointerout', this.hover)
    this.root.removeEventListener('contextmenu', this.menu)
    this.root.style.touchAction = this.previousTouchAction
  }

  private sample(event: PointerEvent): RealSample {
    const time = event.timeStamp
    if (!Number.isFinite(time) || time < 0 || time > performance.now() + 10000 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) throw new Error('Invalid pointer sample')
    const point = this.mappings.map(time, event.clientX, event.clientY)
    const surface = this.mappings.surface(time, event.clientX, event.clientY)
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(surface.x) || !Number.isFinite(surface.y)) throw new Error('Invalid input mapping')
    const source = event.pointerType === 'pen' || event.pointerType === 'touch' ? event.pointerType : 'mouse'
    const pressureKnown = source === 'pen' && Number.isFinite(event.pressure)
    return { pointerId: event.pointerId, sequence: ++this.sequence, source, x: point.x, y: point.y,
      surfaceX: surface.x, surfaceY: surface.y, pressure: pressureKnown ? Math.max(0, Math.min(1, event.pressure)) : 0.5, pressureKnown, time,
      buttons: event.buttons, tiltX: Math.max(-90, Math.min(90, event.tiltX || 0)), tiltY: Math.max(-90, Math.min(90, event.tiltY || 0)), twist: ((event.twist || 0) % 360 + 360) % 360 }
  }

  private batch(contact: Contact, event: PointerEvent, raw: boolean): RealSample[] {
    const coalesced = event.getCoalescedEvents?.() ?? []
    const events = coalesced.length ? [...coalesced] : [event]
    if (event.type === 'pointerup' && coalesced.length && tuple(coalesced[coalesced.length - 1]) !== tuple(event)) events.push(event)
    const result: RealSample[] = []
    let previous = -Infinity
    try { for (const item of events) {
      if (item.pointerId !== contact.id || !Number.isFinite(item.timeStamp) || item.timeStamp < previous) throw new Error('Unordered pointer batch')
      previous = item.timeStamp
      const key = tuple(item)
      // Earlier timestamps are already rejected by the watermark; retain the full
      // equal-time raw suffix so coarse browser clocks cannot reintroduce duplicates.
      if (raw && item.timeStamp > contact.watermark) contact.rawSinceMove.clear()
      if (raw && contact.rawSinceMove.has(key)) continue
      if (!raw) {
        const delivered = contact.rawSinceMove.get(key) ?? 0
        if (delivered) {
          if (delivered === 1) contact.rawSinceMove.delete(key); else contact.rawSinceMove.set(key, delivered - 1)
          continue
        }
      }
      if (item.timeStamp < contact.watermark || contact.suffix.includes(key)) continue
      const sample = this.sample(item)
      result.push(sample)
      contact.watermark = item.timeStamp
      contact.suffix.push(key)
      if (contact.suffix.length > 64) contact.suffix.shift()
      if (raw) contact.rawSinceMove.set(key, (contact.rawSinceMove.get(key) ?? 0) + 1)
    } } catch (error) { throw new PartialPointerBatchError(result, error) }
    if (!raw) contact.rawSinceMove.clear()
    return result
  }

  private down = (event: PointerEvent): void => {
    if (this.contacts.has(event.pointerId)) return
    // Before the first presented frame of a showing there is nothing to place a press with: it is not taken at all (the
    // surface shows the busy cursor meanwhile). Taken, it failed with "No presented input mapping" and the stroke was lost
    // (measured: every stroke drawn during "Loading drawing…" on a dense board, and after each tab switch, until its frame).
    // Only a new press waits; a contact already down keeps its mappings, and the chrome and keys are not involved.
    if (!this.mappings.ready()) return
    try {
      const sample = { ...this.sample(event), clicks: this.clicks(event) }
      if (!this.sink.down(sample, modifiers(event, this.mac), event)) return
      const contact: Contact = { id: event.pointerId, watermark: event.timeStamp, suffix: [tuple(event)], rawSinceMove: new Map() }
      this.contacts.set(event.pointerId, contact)
      try { this.root.setPointerCapture(event.pointerId) } catch { this.end(event.pointerId, 'capture-failed') }
    } catch (error) { this.sink.error?.(error, event.pointerId) }
  }

  /** Only a press that stayed a click continues a run; one from another kind of pointer, too late or too far away starts one. */
  private clicks(event: PointerEvent): number {
    if (event.button !== 0) return 1
    const previous = this.press, source = event.pointerType === 'pen' || event.pointerType === 'touch' ? event.pointerType : 'mouse'
    const run = !!previous && !previous.dragged && previous.kind === source && event.timeStamp >= previous.time
      && event.timeStamp - previous.time <= MULTI_CLICK_MS && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= MULTI_CLICK_CSS[source]
    this.press = { id: event.pointerId, kind: source, x: event.clientX, y: event.clientY, time: event.timeStamp, clicks: run ? previous.clicks + 1 : 1, dragged: false }
    return this.press.clicks
  }
  private process(event: PointerEvent, raw: boolean): void {
    const press = this.press
    if (press && !press.dragged && press.id === event.pointerId && event.buttons
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= CLICK_SLOP_CSS) press.dragged = true
    const contact = this.contacts.get(event.pointerId)
    if (!contact) { if (!raw) this.sink.hover?.(event); return }
    if (raw && event.pointerType !== 'pen' && event.pointerType !== 'mouse') return
    try {
      const samples = this.batch(contact, event, raw)
      if (samples.length) this.sink.move(event.pointerId, samples, modifiers(event, this.mac), event)
    } catch (error) {
      try {
        if (error instanceof PartialPointerBatchError && error.samples.length)
          this.sink.move(event.pointerId, error.samples, modifiers(event, this.mac), event)
      } finally {
        try { this.sink.error?.(error instanceof PartialPointerBatchError ? error.failure : error, event.pointerId) }
        finally { this.end(event.pointerId, 'cancel') }
      }
    }
  }
  private move = (event: PointerEvent): void => { this.process(event, false) }
  private raw = (event: PointerEvent): void => { this.process(event, true) }
  private up = (event: PointerEvent): void => {
    const contact = this.contacts.get(event.pointerId)
    if (!contact) return
    try {
      const samples = this.batch(contact, event, false)
      this.sink.up(event.pointerId, samples, modifiers(event, this.mac), event)
      this.contacts.delete(event.pointerId)
    } catch (error) {
      try {
        if (error instanceof PartialPointerBatchError && error.samples.length)
          this.sink.move(event.pointerId, error.samples, modifiers(event, this.mac), event)
      } finally {
        try { this.sink.error?.(error instanceof PartialPointerBatchError ? error.failure : error, event.pointerId) }
        finally { this.end(event.pointerId, 'cancel') }
      }
    }
  }
  private end(id: number, reason: 'cancel' | 'capture-lost' | 'capture-failed'): void {
    if (!this.contacts.delete(id)) return
    try { this.sink.cancel(id, reason) }
    finally { try { if (this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id) } catch { /* Capture may have ended already. */ } }
  }
  private cancel = (event: PointerEvent): void => {
    // A press the system took back (palm rejection, a system gesture) was no click: the next press starts a new run.
    if (this.press?.id === event.pointerId) this.press.dragged = true
    this.end(event.pointerId, 'cancel')
  }
  private got = (event: PointerEvent): void => { if (this.contacts.has(event.pointerId)) this.sink.captured?.(event.pointerId) }
  private lost = (event: PointerEvent): void => { this.end(event.pointerId, 'capture-lost') }
  private hover = (event: PointerEvent): void => { this.sink.hover?.(event) }
  private menu = (event: MouseEvent): void => {
    if (!this.sink.contextMenu) return
    event.preventDefault()
    if (this.mappings.ready()) this.sink.contextMenu(event)
  }
}
