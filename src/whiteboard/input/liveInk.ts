import { AuthoringSamples } from '../ink/canonicalize'
import type { SampleBuilder, SampleBuilderOptions, SampleSequence } from '../ink/samples'
import type { FinishReason, GestureOwner, Modifiers, RealSample, Tool } from './tool'

export interface InkIdentity {
  readonly nodeId: string
  readonly gestureSequence: number
}
export interface DryInkIdentity extends InkIdentity { readonly nodeRevision: number }

export interface LiveInkContext {
  readonly identity: InkIdentity
  readonly builderOptions: SampleBuilderOptions
  readonly captureDeviceScale: number
  // Capture style, target sheet and local transform at down; implementations write
  // through the session transaction and preserve the same id/lease for undo/redo.
  toLocal(sample: RealSample): { readonly x: number; readonly y: number }
  clearRedoAtDown(): void
  invalidate(): void
  commit(builder: SampleBuilder, identity: InkIdentity, undoImmediately: boolean): DryInkIdentity
  error(error: unknown): void
}

export interface WetInkSnapshot {
  readonly identity: InkIdentity
  readonly samples: SampleSequence
  readonly dry: DryInkIdentity | null
}

// Retain wet geometry until the compositor has the exact dry revision; selection
// of wet versus dry is made once per frame, not by independent layer callbacks.
export class WetInkHandover {
  private readonly pending = new Map<number, WetInkSnapshot>()
  publish(snapshot: WetInkSnapshot): void { this.pending.set(snapshot.identity.gestureSequence, snapshot) }
  clear(identity: InkIdentity): void {
    const existing = this.pending.get(identity.gestureSequence)
    if (existing?.identity.nodeId === identity.nodeId) this.pending.delete(identity.gestureSequence)
  }
  forFrame(dryAvailable: (identity: DryInkIdentity) => boolean): readonly WetInkSnapshot[] {
    const visible: WetInkSnapshot[] = []
    for (const [sequence, pending] of this.pending) {
      if (pending.dry && dryAvailable(pending.dry)) this.pending.delete(sequence)
      else visible.push(pending)
    }
    return visible
  }
}

export class LiveInk implements GestureOwner {
  readonly kind = 'ink' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly builder: AuthoringSamples
  private ended = false
  private last: RealSample | null = null
  private dirty = true
  private dry: DryInkIdentity | null = null
  private snapshot: SampleSequence | null = null

  constructor(first: RealSample, modifiers: Modifiers, private readonly context: LiveInkContext, private readonly handover: WetInkHandover) {
    this.pointerIds = new Set([first.pointerId])
    this.builder = new AuthoringSamples(context.builderOptions, context.captureDeviceScale)
    this.append(first, modifiers)
    context.clearRedoAtDown()
    context.invalidate()
  }

  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    try {
      for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.append(sample, modifiers)
      if (samples.length) this.context.invalidate()
    } catch (error) {
      this.context.error(error)
      this.finish('os-cancel')
    }
  }

  // Called by the shared scheduler, not per input sample.
  publish(): void {
    if (!this.dirty || this.ended) return
    this.snapshot = this.builder.snapshot()
    this.builder.markPublished()
    this.dirty = false
    this.handover.publish({ identity: this.context.identity, samples: this.snapshot, dry: null })
  }

  finish(reason: FinishReason): void {
    if (this.ended) return
    this.ended = true
    try {
      if (this.dirty || !this.snapshot) this.snapshot = this.builder.snapshot()
      this.dry = this.context.commit(this.builder.finish(), this.context.identity, reason === 'undo')
      if (reason === 'undo') this.handover.clear(this.context.identity)
      else this.handover.publish({ identity: this.context.identity, samples: this.snapshot, dry: this.dry })
      this.context.invalidate()
    } catch (error) { this.context.error(error) }
  }

  cancel(): void { this.finish('os-cancel') }

  private append(sample: RealSample, modifiers: Modifiers): void {
    if (this.last && sample.x === this.last.x && sample.y === this.last.y && (!this.context.builderOptions.pressure || sample.pressure === this.last.pressure)) return
    const point = this.context.toLocal(sample)
    const pressure = sample.source === 'pen' && sample.buttons === 0 && sample.pressure === 0 && this.last ? this.last.pressure : sample.pressure
    this.builder.append(point.x, point.y, this.context.builderOptions.pressure ? pressure : undefined, modifiers.shift ? 'straight' : 'freehand')
    this.last = sample
    this.dirty = true
  }
}

export function inkTool(id: 'pen' | 'highlighter', handover: WetInkHandover): Tool<LiveInkContext> {
  return { id, begin: (sample, modifiers, context) => new LiveInk(sample, modifiers, context, handover) }
}
