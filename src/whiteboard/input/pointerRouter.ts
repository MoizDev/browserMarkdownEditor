import { PointerAcquisition, type MappingHistory, type PointerSink } from './pointer'
import { PenContactTransitions } from './penTransitions'
import { InputRouter } from './router'
import type { FinishReason, InputToken, Modifiers, RealSample, Tool } from './tool'

export interface PointerRoute<Context> {
  readonly tool: Tool<Context>; readonly context: Context
  /** The tool returns to Select itself once its work has landed, instead of at pointer-up. */
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
  /** What a press is resolved against (the tool chosen), read when it is pressed: a press queued behind a settling contact is
   * resolved later, with this. */
  pressed?(): Pressed
  sampleChanged?(sample: RealSample): void
  realEvent?(sample: RealSample, event: PointerEvent): void
  penTransitions?(sample: RealSample): boolean
  settled?(signal: AbortSignal): Promise<void>
  cancelPending?(): void
  resolve(sample: RealSample, modifiers: Modifiers, event: PointerEvent, pressed?: Pressed): PointerRoute<Context> | null
  ended(reason: FinishReason): void
  hover?(event: PointerEvent): void
  contextMenu?(event: MouseEvent): void
  error?(error: unknown, id: number): void
}

/** A press taken while the contact before it had lifted but was still landing, with everything its pointer did since. */
interface QueuedContact<Pressed> {
  readonly pointerId: number
  readonly pressed: Pressed | undefined
  readonly events: ({ readonly type: 'down'; readonly sample: RealSample; readonly modifiers: Modifiers; readonly event: PointerEvent }
    | { readonly type: 'move'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers; readonly event: PointerEvent }
    | { readonly type: 'up'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers }
    | { readonly type: 'cancel'; readonly reason: 'cancel' | 'capture-lost' | 'capture-failed' })[]
  lifted: boolean
}

// The host resolves gesture recipes, touch/palm qualification and services first.
// This seam owns pointer-up ordering and routes interruption exactly once.
export class PointerRouter<Context, Pressed = unknown> {
  private readonly acquisition: PointerAcquisition
  private pen: PenContactTransitions | null = null
  private pointerId: number | null = null
  private disposed = false
  /** Presses made while a lifted pen contact still lands (see down), oldest first; replayed in order once it has ended. */
  private readonly queued: QueuedContact<Pressed>[] = []
  /** Pointers whose queued press was refused when replayed: the rest of that contact is theirs to ignore. */
  private readonly refused = new Set<number>()
  constructor(private readonly options: PointerRouterOptions<Context, Pressed>) {
    const sink: PointerSink = {
      down: (sample, modifiers, event) => {
        if (!options.current()) return false
        this.refused.delete(sample.pointerId)
        options.sampleChanged?.(sample); options.realEvent?.(sample, event)
        // A pen contact whose eraser end changed keeps the input until the erase it made has landed (penTransitions.ts), so it is
        // ended in order; that lasts past the lift, and every press meanwhile was refused with no sign: 6 of 6 presses 40 ms after
        // the lift lost their whole stroke, pen and mouse alike, and from 120 ms on every one landed (light board; the window is the
        // erase's landing, longer on a dense board). Such a press is taken and kept, then replayed in order the moment that contact
        // ends, resolved with the tool chosen when it was pressed: drawn, never dropped, landing after what came before it. A second
        // pointer while a queued one is still down is refused, as it would be beside a live contact; so is a finger, whose admission
        // and camera gestures are decided live (attach.ts touchAdmission, TouchArbiter) and cannot be replayed later.
        if (this.pen?.lifted || this.queued.length) {
          if (sample.source === 'touch' || this.queued.some(contact => !contact.lifted)) return false
          this.queued.push({ pointerId: sample.pointerId, pressed: options.pressed?.(), events: [{ type: 'down', sample, modifiers, event }], lifted: false })
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
  /** The queued contact this pointer's events belong to: the newest one with its id, while it is still down. */
  private queuedFor(id: number): QueuedContact<Pressed> | null {
    for (let index = this.queued.length - 1; index >= 0; index--) {
      const contact = this.queued[index]
      if (contact.pointerId === id) return contact.lifted ? null : contact
    }
    return null
  }
  /** Replays queued presses, oldest first, while nothing holds the input; a replayed contact still down goes on live. */
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
  /** Gives the input back after a contact ended, then lets the presses queued behind it in. */
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
        // The contact starts in the mode its pen end is in, not the mode of the tool that took it: ⌘ held over Draw is an eraser
        // with the tip down, and started as 'eraser' its first sample (no eraser bit) read as a change back to ink, which finished
        // that erase at the press point and began a second, two undo steps for a press that started on a stroke.
        const transition: PenContactTransitions = new PenContactTransitions(sample.pointerId, (sample.buttons & 32) !== 0 ? 'eraser' : 'ink', {
          current: () => options.current() && this.pen === transition && this.pointerId === sample.pointerId,
          owner: () => options.router.activeOwner,
          finish: reason => options.router.finish(options.token, sample.pointerId, reason),
          interrupt: reason => options.router.interrupt(options.token, reason),
          update: (samples, keys) => options.router.update(options.token, sample.pointerId, samples, keys),
          begin: (point, keys, source) => {
            // A resumed tip starts a fresh segment even if Shift remains held;
            // resolving continuation here would bridge across the erased gap.
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
    this.queued.length = 0; this.refused.clear()
    this.interrupt('flush')
    this.acquisition.dispose()
    this.options.router.detach(this.options.token)
  }
}
