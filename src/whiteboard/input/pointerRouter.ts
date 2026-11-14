import { PointerAcquisition, type MappingHistory, type PointerSink } from './pointer'
import { InputRouter } from './router'
import type { FinishReason, InputToken, Modifiers, RealSample, Tool } from './tool'

export interface PointerRoute<Context> { readonly tool: Tool<Context>; readonly context: Context }
export interface PointerRouterOptions<Context> {
  readonly root: HTMLElement
  readonly mappings: MappingHistory
  readonly token: InputToken
  readonly router: InputRouter<Context>
  readonly mac: boolean
  readonly current: () => boolean
  claim(): boolean
  releaseClaim(): void
  sampleChanged?(sample: RealSample): void
  resolve(sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<Context> | null
  ended(reason: FinishReason): void
  hover?(event: PointerEvent): void
  prediction?(id: number, event: PointerEvent | null): void
  contextMenu?(event: MouseEvent): void
  error?(error: unknown, id: number): void
}

// The host resolves gesture recipes, touch/palm qualification and services first.
// This seam owns pointer-up ordering and routes interruption exactly once.
export class PointerRouter<Context> {
  private readonly acquisition: PointerAcquisition
  private pointerId: number | null = null
  private disposed = false
  constructor(private readonly options: PointerRouterOptions<Context>) {
    const sink: PointerSink = {
      down: (sample, modifiers, event) => {
        if (!options.current()) return false
        options.sampleChanged?.(sample)
        const route = options.resolve(sample, modifiers, event)
        if (!route || !options.claim()) return false
        try {
          if (!options.router.begin(options.token, route.tool, sample, modifiers, route.context)) { options.releaseClaim(); return false }
          this.pointerId = sample.pointerId
          return true
        } catch (error) { options.releaseClaim(); throw error }
      },
      move: (id, samples, modifiers) => { if (options.current()) { if (samples.length) options.sampleChanged?.(samples[samples.length - 1]); options.router.update(options.token, id, samples, modifiers) } },
      up: (id, samples, modifiers) => {
        if (this.pointerId !== id || !options.current()) return
        if (samples.length) options.sampleChanged?.(samples[samples.length - 1])
        options.router.update(options.token, id, samples, modifiers)
        this.pointerId = null
        try { options.router.finish(options.token, id, 'up') } finally { options.releaseClaim(); options.ended('up') }
      },
      cancel: (id, reason) => {
        if (this.pointerId !== id) return
        this.pointerId = null
        const end = reason === 'capture-lost' ? 'capture-lost' : 'os-cancel'
        try { options.router.interrupt(options.token, 'os-cancel') } finally { options.releaseClaim(); options.ended(end) }
      },
      hover: event => options.hover?.(event),
      prediction: (id, event) => options.prediction?.(id, event),
      contextMenu: options.contextMenu,
      error: (error, id) => options.error?.(error, id),
    }
    options.router.attach(options.token)
    this.acquisition = new PointerAcquisition(options.root, options.mappings, sink, options.mac)
  }
  modifiersChanged(modifiers: Modifiers): void {
    if (this.options.current() && this.pointerId !== null) this.options.router.update(this.options.token, this.pointerId, [], modifiers)
  }
  discardPreview(): void {
    if (this.options.router.discardPreview(this.options.token)) { this.pointerId = null; this.options.releaseClaim(); this.options.ended('os-cancel') }
  }
  interrupt(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean {
    const ended = this.options.router.interrupt(this.options.token, reason)
    if (ended) { this.pointerId = null; this.options.releaseClaim(); this.options.ended(reason) }
    return ended
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.interrupt('flush')
    this.acquisition.dispose()
    this.options.router.detach(this.options.token)
  }
}
