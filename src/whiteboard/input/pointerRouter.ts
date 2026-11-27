import { PointerAcquisition, type MappingHistory, type PointerSink } from './pointer'
import { PenContactTransitions } from './penTransitions'
import { InputRouter } from './router'
import type { FinishReason, InputToken, Modifiers, RealSample, Tool } from './tool'

export interface PointerRoute<Context> {
  readonly tool: Tool<Context>; readonly context: Context
  readonly completesTool?: boolean
}
export interface PointerRouterOptions<Context, Pressed = unknown> {
  readonly root: HTMLElement
  readonly mappings: MappingHistory
  readonly token: InputToken
  readonly router: InputRouter<Context>
  readonly mac: boolean
  readonly current: () => boolean
  claim(): boolean
  releaseClaim(): void
  pressed?(): Pressed | undefined
  sampleChanged?(sample: RealSample): void
  realEvent?(sample: RealSample, event: PointerEvent): void
  penTransitions?(sample: RealSample): boolean
  settled?(signal: AbortSignal): Promise<void>
  landing?(): boolean
  cancelPending?(): void
  resolve(sample: RealSample, modifiers: Modifiers, event: PointerEvent, pressed?: Pressed): PointerRoute<Context> | null
  ended(reason: FinishReason): void
  hover?(event: PointerEvent): void
  contextMenu?(event: MouseEvent): void
  error?(error: unknown, id: number): void
}

interface QueuedContact<Pressed> {
  readonly pointerId: number
  readonly pressed: Pressed | undefined
  readonly events: ({ readonly type: 'down'; readonly sample: RealSample; readonly modifiers: Modifiers; readonly event: PointerEvent }
    | { readonly type: 'move'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers; readonly event: PointerEvent }
    | { readonly type: 'up'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers }
    | { readonly type: 'cancel'; readonly reason: 'cancel' | 'capture-lost' | 'capture-failed' })[]
  lifted: boolean
}

export class PointerRouter<Context, Pressed = unknown> {
  private readonly acquisition: PointerAcquisition
  private pen: PenContactTransitions | null = null
  private pointerId: number | null = null
  private disposed = false
  private readonly queued: QueuedContact<Pressed>[] = []
  private readonly refused = new Set<number>()
  private landed: AbortController | null = null
  constructor(private readonly options: PointerRouterOptions<Context, Pressed>) {
    const sink: PointerSink = {
      down: (sample, modifiers, event) => {
        if (!options.current()) return false
        this.refused.delete(sample.pointerId)
        options.sampleChanged?.(sample); options.realEvent?.(sample, event)
        const landing = !this.pen && this.pointerId === null && !!options.settled && options.landing?.() === true
        if (this.pen?.lifted || this.queued.length || landing) {
          if (sample.source === 'touch' || this.queued.some(contact => !contact.lifted)) return false
          this.queued.push({ pointerId: sample.pointerId, pressed: options.pressed?.(), events: [{ type: 'down', sample, modifiers, event }], lifted: false })
          if (landing) this.replayWhenLanded()
          return true
        }
        return this.press(sample, modifiers, event, undefined)
      },
      move: (id, samples, modifiers, event) => {
        if (!options.current()) return
        const queued = this.queuedFor(id)
        if (queued) { queued.events.push({ type: 'move', samples, modifiers, event }); return }
        if (this.refused.has(id)) return
        if (samples.length) { options.sampleChanged?.(samples[samples.length - 1]); options.realEvent?.(samples[samples.length - 1], event) }
        this.moveContact(id, samples, modifiers, event)
      },
      up: (id, samples, modifiers) => {
        const queued = this.queuedFor(id)
        if (queued) { queued.events.push({ type: 'up', samples, modifiers }); queued.lifted = true; return }
        if (this.refused.delete(id)) return
        if (this.pointerId === id && options.current() && samples.length) options.sampleChanged?.(samples[samples.length - 1])
        this.lift(id, samples, modifiers)
      },
      cancel: (id, reason) => {
        const queued = this.queuedFor(id)
        if (queued) { queued.events.push({ type: 'cancel', reason }); queued.lifted = true; return }
        if (this.refused.delete(id)) return
        this.cancelContact(id, reason)
      },
      hover: event => options.hover?.(event),
      contextMenu: options.contextMenu,
      error: (error, id) => options.error?.(error, id),
    }
    options.router.attach(options.token)
    this.acquisition = new PointerAcquisition(options.root, options.mappings, sink, options.mac)
  }
  private queuedFor(id: number): QueuedContact<Pressed> | null {
    for (let index = this.queued.length - 1; index >= 0; index--) {
      const contact = this.queued[index]
      if (contact.pointerId === id) return contact.lifted ? null : contact
    }
    return null
  }
  private replay(): void {
    while (this.queued.length && !this.pen && this.pointerId === null) {
      const contact = this.queued.shift()!
      if (this.disposed || !this.options.current()) continue
      try {
        for (const queued of contact.events) {
          if (queued.type === 'down') {
            if (this.press(queued.sample, queued.modifiers, queued.event, contact.pressed)) continue
            if (!contact.lifted) this.refused.add(contact.pointerId)
            break
          }
          if (queued.type === 'move') this.moveContact(contact.pointerId, queued.samples, queued.modifiers, queued.event)
          else if (queued.type === 'up') this.lift(contact.pointerId, queued.samples, queued.modifiers)
          else this.cancelContact(contact.pointerId, queued.reason)
        }
      } catch (error) { this.options.error?.(error, contact.pointerId) }
    }
  }
  private replayWhenLanded(): void {
    if (this.landed || !this.options.settled) return
    const controller = this.landed = new AbortController()
    void this.options.settled(controller.signal).catch(() => undefined).then(() => {
      if (this.landed !== controller) return
      this.landed = null
      if (this.disposed) return
      if (this.options.landing?.() === true && this.queued.length) { this.replayWhenLanded(); return }
      this.replay()
    })
  }
  private released(reason: FinishReason): void {
    try { this.options.releaseClaim() } finally {
      try { this.options.ended(reason) } finally { this.replay() }
    }
  }
  private press(sample: RealSample, modifiers: Modifiers, event: PointerEvent, pressed: Pressed | undefined): boolean {
    const options = this.options
    if (!options.claim()) return false
    try {
      const route = options.resolve(sample, modifiers, event, pressed)
      if (!route || !options.router.begin(options.token, route.tool, sample, modifiers, route.context)) { options.releaseClaim(); return false }
      this.pointerId = sample.pointerId
      const owner = options.router.activeOwner
      if (sample.source === 'pen' && options.penTransitions?.(sample) && options.settled
        && (owner?.kind === 'ink' || owner?.kind === 'erase')) {
        const transition: PenContactTransitions = new PenContactTransitions(sample.pointerId, (sample.buttons & 32) !== 0 ? 'eraser' : 'ink', {
          current: () => options.current() && this.pen === transition && this.pointerId === sample.pointerId,
          owner: () => options.router.activeOwner,
          finish: reason => options.router.finish(options.token, sample.pointerId, reason),
          interrupt: reason => options.router.interrupt(options.token, reason),
          update: (samples, keys) => options.router.update(options.token, sample.pointerId, samples, keys),
          begin: (point, keys, source) => {
            const next = options.resolve(point, { ...keys, shift: false }, source)
            if (!next || this.pen !== transition || !options.router.begin(options.token, next.tool, point, keys, next.context)) return false
            // Resolving or beginning can end this contact (a tool change flushes it). What began then has no contact left to
            // finish it, and its gesture hold refused every later press until a reload: it is discarded with its hold.
            if (this.pen === transition) return true
            options.router.discardPreview(options.token)
            return false
          },
          prepareInk: (point, keys, source) => {
            const next = options.resolve(point, { ...keys, shift: false }, source)
            const owner = next?.tool.begin(point, keys, next.context) ?? null
            if (!owner || (owner.kind === 'ink' && owner.discard)) return owner
            // Not ink (an eraser, a pan): it was begun only to be refused, and an eraser takes a gesture hold as it begins.
            // Dropped without a cancel, that hold refused every later press until a reload.
            owner.cancel('invalidated')
            return null
          },
          cancelPending: () => options.cancelPending?.(),
          settled: signal => options.settled!(signal),
          ended: reason => {
            if (this.pen !== transition) return
            this.pen = null; this.pointerId = null
            this.released(reason)
          },
          error: error => options.error?.(error, sample.pointerId),
        })
        this.pen = transition
      }
      return true
    } catch (error) { options.releaseClaim(); throw error }
  }
  private moveContact(id: number, samples: readonly RealSample[], modifiers: Modifiers, event: PointerEvent): void {
    if (this.pen?.pointerId === id) this.pen.move(samples, modifiers, event)
    else this.options.router.update(this.options.token, id, samples, modifiers)
  }
  private lift(id: number, samples: readonly RealSample[], modifiers: Modifiers): void {
    const options = this.options
    if (this.pointerId !== id) return
    if (!options.current()) {
      if (this.pen?.pointerId === id) { this.pen.stop('os-cancel'); return }
      this.pointerId = null
      try { options.router.interrupt(options.token, 'os-cancel') } finally { this.released('os-cancel') }
      return
    }
    if (this.pen?.pointerId === id) { this.pen.end(samples, modifiers, 'up'); return }
    options.router.update(options.token, id, samples, modifiers)
    this.pointerId = null
    try { options.router.finish(options.token, id, 'up') } finally { this.released('up') }
  }
  private cancelContact(id: number, reason: 'cancel' | 'capture-lost' | 'capture-failed'): void {
    const options = this.options
    if (this.pointerId !== id) return
    const end = reason === 'capture-lost' ? 'capture-lost' : 'os-cancel'
    if (this.pen?.pointerId === id) {
      this.pen.end([], { shift: false, alt: false, accel: false, control: false }, end); return
    }
    this.pointerId = null
    try { options.router.interrupt(options.token, 'os-cancel') } finally { this.released(end) }
  }
  publishPendingInk(): boolean { return this.pen?.publishPending() ?? false }
  modifiersChanged(modifiers: Modifiers): void {
    if (!this.options.current() || this.pointerId === null) return
    if (this.pen) this.pen.modifiersChanged(modifiers)
    else this.options.router.update(this.options.token, this.pointerId, [], modifiers)
  }
  discardPreview(): void {
    if (this.options.router.discardPreview(this.options.token)) { this.pointerId = null; this.released('os-cancel') }
  }
  interrupt(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean {
    if (this.pen) return this.pen.interrupt(reason)
    const ended = this.options.router.interrupt(this.options.token, reason)
    if (ended) { this.pointerId = null; this.released(reason) }
    return ended
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queued.length = 0; this.refused.clear(); this.landed?.abort(); this.landed = null
    this.interrupt('flush')
    this.acquisition.dispose()
    this.options.router.detach(this.options.token)
  }
}
