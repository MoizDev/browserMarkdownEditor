import type { Modifiers, RealSample } from './tool'

export interface PresentedMapping {
  readonly time: number
  clientToWorld(x: number, y: number): { readonly x: number; readonly y: number }
}

// Record mappings only after presentation, not when a future camera is scheduled.
export class MappingHistory {
  private entries: PresentedMapping[] = []
  constructor(private readonly onExpired: () => void = () => {}) {}
  present(mapping: PresentedMapping): void {
    if (!Number.isFinite(mapping.time) || (this.entries.length && mapping.time < this.entries[this.entries.length - 1].time)) throw new Error('Invalid presentation time')
    this.entries.push(mapping)
    // Retain at least 250 ms even at very high frame rates.
    while (this.entries.length > 64 && mapping.time - this.entries[1].time >= 250) this.entries.shift()
  }
  map(time: number, x: number, y: number): { readonly x: number; readonly y: number } {
    if (!this.entries.length) throw new Error('No presented input mapping')
    let i = this.entries.length - 1
    while (i > 0 && this.entries[i].time > time) i--
    if (time < this.entries[0].time) this.onExpired()
    return this.entries[i].clientToWorld(x, y)
  }
}

export interface PointerSink {
  down(sample: RealSample, modifiers: Modifiers, event: PointerEvent): boolean
  move(pointerId: number, samples: readonly RealSample[], modifiers: Modifiers, event: PointerEvent): void
  up(pointerId: number, samples: readonly RealSample[], modifiers: Modifiers, event: PointerEvent): void
  cancel(pointerId: number, reason: 'cancel' | 'capture-lost' | 'capture-failed'): void
  hover?(event: PointerEvent): void
  captured?(pointerId: number): void
  prediction?(pointerId: number, event: PointerEvent | null): void
  contextMenu?(event: MouseEvent): void
  error?(error: unknown, pointerId: number): void
}

interface Contact {
  readonly id: number
  watermark: number
  suffix: string[]
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
    for (const id of [...this.contacts.keys()]) this.end(id, 'capture-lost')
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
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid input mapping')
    const source = event.pointerType === 'pen' || event.pointerType === 'touch' ? event.pointerType : 'mouse'
    const pressureKnown = source === 'pen' && Number.isFinite(event.pressure)
    return { pointerId: event.pointerId, sequence: ++this.sequence, source, x: point.x, y: point.y,
      pressure: pressureKnown ? Math.max(0, Math.min(1, event.pressure)) : 0.5, pressureKnown, time,
      buttons: event.buttons, tiltX: Math.max(-90, Math.min(90, event.tiltX || 0)), tiltY: Math.max(-90, Math.min(90, event.tiltY || 0)), twist: ((event.twist || 0) % 360 + 360) % 360 }
  }

  private batch(contact: Contact, event: PointerEvent): RealSample[] {
    const coalesced = event.getCoalescedEvents?.() ?? []
    const events = coalesced.length ? [...coalesced] : [event]
    if (event.type === 'pointerup' && coalesced.length && tuple(coalesced[coalesced.length - 1]) !== tuple(event)) events.push(event)
    const result: RealSample[] = []
    let previous = -Infinity
    for (const item of events) {
      if (item.pointerId !== contact.id || !Number.isFinite(item.timeStamp) || item.timeStamp < previous) throw new Error('Unordered pointer batch')
      previous = item.timeStamp
      const key = tuple(item)
      if (item.timeStamp < contact.watermark || contact.suffix.includes(key)) continue
      const sample = this.sample(item)
      contact.watermark = item.timeStamp
      contact.suffix.push(key)
      if (contact.suffix.length > 64) contact.suffix.shift()
      result.push(sample)
    }
    return result
  }

  private down = (event: PointerEvent): void => {
    this.sink.prediction?.(event.pointerId, null)
    if (this.contacts.has(event.pointerId)) return
    try {
      const sample = this.sample(event)
      if (!this.sink.down(sample, modifiers(event, this.mac), event)) return
      const contact: Contact = { id: event.pointerId, watermark: event.timeStamp, suffix: [tuple(event)] }
      this.contacts.set(event.pointerId, contact)
      try { this.root.setPointerCapture(event.pointerId) } catch { this.end(event.pointerId, 'capture-failed') }
    } catch (error) { this.sink.error?.(error, event.pointerId) }
  }

  private process(event: PointerEvent, raw: boolean): void {
    const contact = this.contacts.get(event.pointerId)
    if (!contact) { if (!raw) this.sink.hover?.(event); return }
    if (raw && event.pointerType !== 'pen' && event.pointerType !== 'mouse') return
    this.sink.prediction?.(event.pointerId, null)
    try {
      const samples = this.batch(contact, event)
      if (samples.length) this.sink.move(event.pointerId, samples, modifiers(event, this.mac), event)
      if (!raw) this.sink.prediction?.(event.pointerId, event)
    } catch (error) { this.sink.error?.(error, event.pointerId); this.end(event.pointerId, 'cancel') }
  }
  private move = (event: PointerEvent): void => { this.process(event, false) }
  private raw = (event: PointerEvent): void => { this.process(event, true) }
  private up = (event: PointerEvent): void => {
    const contact = this.contacts.get(event.pointerId)
    if (!contact) return
    this.sink.prediction?.(event.pointerId, null)
    try {
      const samples = this.batch(contact, event)
      this.contacts.delete(event.pointerId)
      this.sink.up(event.pointerId, samples, modifiers(event, this.mac), event)
    } catch (error) { this.sink.error?.(error, event.pointerId); this.end(event.pointerId, 'cancel') }
  }
  private end(id: number, reason: 'cancel' | 'capture-lost' | 'capture-failed'): void {
    if (!this.contacts.delete(id)) return
    this.sink.prediction?.(id, null)
    this.sink.cancel(id, reason)
    try { if (this.root.hasPointerCapture(id)) this.root.releasePointerCapture(id) } catch { /* Capture may have ended already. */ }
  }
  private cancel = (event: PointerEvent): void => { this.end(event.pointerId, 'cancel') }
  private got = (event: PointerEvent): void => { if (this.contacts.has(event.pointerId)) this.sink.captured?.(event.pointerId) }
  private lost = (event: PointerEvent): void => { this.end(event.pointerId, 'capture-lost') }
  private hover = (event: PointerEvent): void => { this.sink.hover?.(event) }
  private menu = (event: MouseEvent): void => { this.sink.contextMenu?.(event) }
}
