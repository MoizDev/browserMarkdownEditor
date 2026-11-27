import type { TextToolContext } from '../text/edit/tool'
import type { ToolChoice, ToolStateSnapshot } from './gesture'
import type { MappingHistory } from './pointer'
import type { PointerRoute } from './pointerRouter'
import type { InputRouter } from './router'
import { CLICK_SLOP_CSS, type GestureOwner, type InputToken, type Modifiers, type RealSample, type Tool } from './tool'

const TOUCH_LEAVE_CSS = 25

export interface ChromeToolDragOptions<Context> {
  readonly token: InputToken
  readonly router: InputRouter<Context>
  readonly mappings: MappingHistory
  readonly mac: boolean
  readonly current: () => boolean
  readonly editable: () => boolean
  claim(): boolean
  releaseClaim(): void
  resolve(choice: ToolChoice, sample: RealSample, modifiers: Modifiers): PointerRoute<Context> | null
  select(choice: ToolChoice): void
  snapshot(): ToolStateSnapshot
  complete(start: ToolStateSnapshot): void
  focus(): void
  error(error: unknown): void
}

interface Armed<Context> {
  readonly id: number
  readonly choice: ToolChoice
  readonly bar: Element
  readonly x: number
  readonly y: number
  start: ToolStateSnapshot
  readonly touch: boolean
  route: PointerRoute<Context> | null
  readonly listeners: Array<() => void>
}

export class ChromeToolDrag<Context> {
  private armed: Armed<Context> | null = null
  private sequence = 0
  constructor(private readonly options: ChromeToolDragOptions<Context>) {}

  begin(choice: ToolChoice, event: PointerEvent, bar: Element): boolean {
    const { options } = this
    if (this.armed || event.button !== 0 || !options.current() || !options.editable()) return false
    if (!options.claim()) return false
    const start = options.snapshot()
    const armed: Armed<Context> = { id: event.pointerId, choice, bar, x: event.clientX, y: event.clientY, start,
      touch: event.pointerType === 'touch', route: null, listeners: [] }
    const onMove = (next: PointerEvent) => this.move(next)
    const onUp = (next: PointerEvent) => this.up(next)
    const onCancel = (next: PointerEvent) => this.cancel(next)
    const onKey = (next: KeyboardEvent) => { if (next.key === 'Escape') this.escape() }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    armed.listeners.push(
      () => window.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
      () => window.removeEventListener('pointercancel', onCancel),
      () => window.removeEventListener('keydown', onKey, true),
    )
    this.armed = armed
    if (armed.touch) options.select(choice)
    return true
  }

  private move(event: PointerEvent): void {
    const armed = this.armed
    if (!armed || event.pointerId !== armed.id) return
    const { options } = this
    if (!armed.route) {
      if (!options.current()) { this.end(); return; }
      const threshold = armed.touch ? TOUCH_LEAVE_CSS : CLICK_SLOP_CSS
      if (Math.hypot(event.clientX - armed.x, event.clientY - armed.y) < threshold) return
      const rect = armed.bar.getBoundingClientRect()
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return
      if (!options.mappings.ready()) return
      try {
        const sample = this.sample(event), modifiers = this.modifiers(event)
        const route = options.resolve(armed.choice, sample, modifiers)
        if (!route) { this.end(); return; }
        options.select(armed.choice)
        armed.start = options.snapshot()
        if (!options.router.begin(options.token, route.tool, sample, modifiers, route.context)) { this.end(); return; }
        armed.route = route
      } catch (error) { this.end(); options.error(error); }
      return
    }
    try { options.router.update(options.token, armed.id, [this.sample(event)], this.modifiers(event)) }
    catch (error) { this.cancelGesture('os-cancel'); options.error(error); }
  }

  private up(event: PointerEvent): void {
    const armed = this.armed
    if (!armed || event.pointerId !== armed.id) return
    const { options } = this
    if (!armed.route) { this.end(); return; }
    const swallow = (click: Event) => { click.stopPropagation(); click.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    try {
      const sample = this.sample(event), modifiers = this.modifiers(event)
      options.router.update(options.token, armed.id, [sample], modifiers)
      options.router.finish(options.token, armed.id, 'up')
      if (!armed.route.completesTool && options.editable()) options.complete(armed.start)
    } catch (error) { options.error(error) }
    finally { this.end() }
  }

  private cancel(event: PointerEvent): void {
    const armed = this.armed
    if (!armed || event.pointerId !== armed.id) return
    this.cancelGesture('os-cancel')
  }

  private escape(): void { this.cancelGesture('escape') }

  private cancelGesture(reason: 'escape' | 'os-cancel'): void {
    const armed = this.armed
    if (!armed) return
    try { if (armed.route) this.options.router.interrupt(this.options.token, reason) }
    finally { this.end() }
  }

  private end(): void {
    const armed = this.armed
    if (!armed) return
    this.armed = null
    for (const remove of armed.listeners) remove()
    this.options.releaseClaim()
    this.options.focus()
  }

  private sample(event: PointerEvent): RealSample {
    const { mappings } = this.options, time = event.timeStamp
    if (!Number.isFinite(time) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) throw new Error('Invalid pointer sample')
    const point = mappings.map(time, event.clientX, event.clientY), surface = mappings.surface(time, event.clientX, event.clientY)
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(surface.x) || !Number.isFinite(surface.y)) throw new Error('Invalid input mapping')
    const source = event.pointerType === 'pen' || event.pointerType === 'touch' ? event.pointerType : 'mouse'
    const pressureKnown = source === 'pen' && Number.isFinite(event.pressure)
    return { pointerId: event.pointerId, sequence: ++this.sequence, source, x: point.x, y: point.y, surfaceX: surface.x, surfaceY: surface.y,
      pressure: pressureKnown ? Math.max(0, Math.min(1, event.pressure)) : 0.5, pressureKnown, time, buttons: event.buttons,
      tiltX: 0, tiltY: 0, twist: 0 }
  }

  private modifiers(event: PointerEvent): Modifiers {
    return { shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, accel: this.options.mac ? event.metaKey : event.ctrlKey }
  }
}

export function textDropTool(label: string | undefined): Tool<TextToolContext> {
  return {
    id: 'text',
    begin(first: RealSample, _modifiers: Modifiers, context: TextToolContext): GestureOwner {
      let last = first
      context.previewTextColumn(first.x, first.y, null)
      return {
        kind: 'node-edit', pointerIds: new Set([first.pointerId]),
        update(samples) {
          for (const sample of samples) if (sample.pointerId === first.pointerId) last = sample
          context.previewTextColumn(last.x, last.y, null)
        },
        finish(reason) {
          context.clearTextColumnPreview()
          if (reason === 'up') context.createText(last.x, last.y, null, label || undefined)
        },
        cancel() { context.clearTextColumnPreview() },
      }
    },
  }
}
