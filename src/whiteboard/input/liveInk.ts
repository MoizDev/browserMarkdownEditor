import { LocalCurveBuilder, type CurvePublication } from '../ink/curve'
import { StraightInkBuilder } from './straightInk'
import type { SampleBuilder, SampleBuilderOptions } from '../ink/samples'
import type { FinishReason, GestureOwner, Modifiers, RealSample, Tool } from './tool'
import type { PaintClip } from '../render/paintStream'

export interface InkIdentity {
  readonly nodeId: string
  readonly gestureSequence: number
}
export interface DryInkIdentity extends InkIdentity {
  readonly nodeRevision: number
  /** Owned by the handover after publication; not a frame consumer lease. */
  readonly release?: () => void
}

export interface InkPresentation {
  readonly tool: 'pen' | 'highlighter'
  readonly color: string
  readonly width: number
  readonly fairTol: number
  readonly localToWorld: readonly [number, number, number, number, number, number]
  /** Continuations inherit their existing node's opacity and ancestor frame clips. */
  readonly opacity?: number
  readonly clips?: readonly PaintClip[]
}

/** A point the caller owns and reuses: the live stroke maps every pointer sample into one, so the mapping allocates nothing. */
export interface LocalPoint { x: number; y: number }

export interface LiveInkContext {
  readonly identity: InkIdentity
  readonly presentation: InkPresentation
  readonly builderOptions: SampleBuilderOptions
  readonly captureDeviceScale: number
  /** One CSS pixel of pointer input in local units at pointer down (1 / zoom): the coarsest grid the
   * pointer's samples can sit on (ink/dequantize.ts). */
  readonly inputPixelWorld: number
  // Capture style, target sheet and local transform at down; implementations write
  // through the session transaction and preserve the same id/lease for undo/redo.
  /** Writes the sample's local point into `out`. */
  toLocal(sample: RealSample, out: LocalPoint): void
  clearRedoAtDown(): void
  invalidate(): void
  commit(builder: SampleBuilder, identity: InkIdentity, undoImmediately: boolean, closed: boolean): DryInkIdentity
  error(error: unknown): void
}

export interface WetInkSnapshot {
  readonly identity: InkIdentity
  readonly presentation: InkPresentation
  readonly curve: CurvePublication
  readonly dry: DryInkIdentity | null
}

// Retain wet geometry until the compositor has the exact dry revision; selection
// of wet versus dry is made once per frame, not by independent layer callbacks.
export class WetInkHandover {
  private readonly pending = new Map<number, WetInkSnapshot>()
  // The pending list as one array, rebuilt only when a stroke is published, cleared or disposed: the wet layer reads it
  // several times per frame, and a fresh array per read was per-frame allocation for an unchanged set.
  private pendingList: readonly WetInkSnapshot[] | null = null
  private listener: (() => void) | null = null
  // The wet layer subscribes so a publication (the pen-up that seals the stroke tail included) asks for a frame.
  onPublish(listener: (() => void) | null): void { this.listener = listener }
  publish(snapshot: WetInkSnapshot): void {
    const previous = this.pending.get(snapshot.identity.gestureSequence)
    if (previous?.dry && previous.dry !== snapshot.dry) previous.dry.release?.()
    this.pending.set(snapshot.identity.gestureSequence, snapshot)
    this.pendingList = null
    this.listener?.()
  }
  clear(identity: InkIdentity): void {
    const existing = this.pending.get(identity.gestureSequence)
    if (existing?.identity.nodeId === identity.nodeId) {
      this.pending.delete(identity.gestureSequence); this.pendingList = null
      existing.dry?.release?.()
    }
  }
  dispose(): void {
    const pending = [...this.pending.values()]; this.pending.clear(); this.pendingList = null
    for (const entry of pending) entry.dry?.release?.()
  }
  /** Every stroke not yet acknowledged, drawn or not. Visibility is the acknowledgement's alone: a dry frame that merely
   * lists the node does not end the wet stroke, because the board may not have composed its tiles yet. */
  pendingSnapshots(): readonly WetInkSnapshot[] {
    return this.pendingList ??= [...this.pending.values()]
  }
  // The compositor calls this only after the token-matched frame with both dry
  // bands was actually presented; dropped or stale frames retain the fallback.
  acknowledgePresented(identity: DryInkIdentity): void {
    const pending = this.pending.get(identity.gestureSequence)
    if (pending?.dry && pending.dry.nodeId === identity.nodeId && pending.dry.nodeRevision === identity.nodeRevision) this.clear(identity)
  }
}

export class LiveInk implements GestureOwner {
  readonly kind = 'ink' as const
  readonly pointerIds: ReadonlySet<number>
  private readonly builder: StraightInkBuilder
  private ended = false
  private last: RealSample | null = null
  private dirty = true
  private dry: DryInkIdentity | null = null
  private snapshot: CurvePublication | null = null
  private readonly point: LocalPoint = { x: 0, y: 0 }
  // The delegated bridge reads these once per input frame. One record is updated in place, so a read allocates nothing; the
  // bridge copies the fields it keeps, and the identity and presentation it holds are stable references.
  private readonly read: { identity: InkIdentity; presentation: InkPresentation; sample: RealSample; curveSequence: number }
  get delegatedState(): Readonly<{ identity: InkIdentity; presentation: InkPresentation; sample: RealSample }> | null {
    if (this.ended || !this.last) return null
    this.read.sample = this.last
    return this.read
  }
  get delegatedCandidate(): Readonly<{ identity: InkIdentity; presentation: InkPresentation; sample: RealSample; curveSequence: number }> | null {
    if (this.ended || !this.last || !this.snapshot) return null
    this.read.sample = this.last; this.read.curveSequence = this.snapshot.sequence
    return this.read
  }

  constructor(first: RealSample, modifiers: Modifiers, private readonly context: LiveInkContext, private readonly handover: WetInkHandover) {
    this.pointerIds = new Set([first.pointerId])
    this.read = { identity: context.identity, presentation: context.presentation, sample: first, curveSequence: -1 }
    this.builder = new StraightInkBuilder(new LocalCurveBuilder(context.builderOptions, context.captureDeviceScale, context.presentation.fairTol,
      undefined, context.inputPixelWorld))
    this.append(first, modifiers)
    context.clearRedoAtDown()
    context.invalidate()
  }

  update(samples: readonly RealSample[], modifiers: Modifiers): void {
    if (this.ended) return
    try {
      const sealed = !modifiers.shift && this.builder.flush()
      if (sealed) this.dirty = true
      for (const sample of samples) if (this.pointerIds.has(sample.pointerId)) this.append(sample, modifiers)
      if (samples.length || sealed) this.context.invalidate()
    } catch (error) {
      this.context.error(error)
      this.finish('os-cancel')
    }
  }

  // Called by the shared scheduler, not per input sample. `force` republishes a clean stroke.
  publish(force = false): void {
    if ((!this.dirty && !force) || this.ended) return
    this.snapshot = this.builder.publish()
    this.dirty = false
    this.handover.publish({ identity: this.context.identity, presentation: this.context.presentation, curve: this.snapshot, dry: null })
  }

  suspend(): void { this.publish(true) }

  finish(reason: FinishReason): void {
    if (this.ended) return
    this.ended = true
    try {
      const finished = this.builder.finish()
      this.snapshot = finished.publication
      const points = finished.publication.samples, last = points.count - 1
      // R-20 keeps closure inert; only an exact, non-degenerate loop is marked.
      const closed = this.context.presentation.tool === 'pen' && points.count >= 4
        && points.x(0) === points.x(last) && points.y(0) === points.y(last)
      this.dry = this.context.commit(finished.samples, this.context.identity, reason === 'undo', closed)
      if (reason === 'undo') this.handover.clear(this.context.identity)
      else {
        try { this.handover.publish({ identity: this.context.identity, presentation: this.context.presentation, curve: this.snapshot, dry: this.dry }) }
        catch (error) { this.dry.release?.(); throw error }
      }
      this.context.invalidate()
    } catch (error) {
      // A failed seal has no dry revision that can ever acknowledge its wet prefix.
      if (!this.dry) { this.handover.clear(this.context.identity); this.context.invalidate() }
      this.context.error(error)
    }
  }

  cancel(): void { this.finish('os-cancel') }
  discard(): void {
    if (this.ended) return
    this.ended = true
    this.handover.clear(this.context.identity)
    this.context.invalidate()
  }

  private append(sample: RealSample, modifiers: Modifiers): void {
    if (this.last && sample.x === this.last.x && sample.y === this.last.y && (!this.context.builderOptions.pressure || sample.pressure === this.last.pressure)) return
    const point = this.point
    this.context.toLocal(sample, point)
    const pressure = sample.source === 'pen' && sample.buttons === 0 && sample.pressure === 0 && this.last ? this.last.pressure : sample.pressure
    this.builder.append(point.x, point.y, this.context.builderOptions.pressure ? pressure : undefined, modifiers.shift)
    this.last = sample
    this.dirty = true
  }
}

export function inkTool(id: 'pen' | 'highlighter', handover: WetInkHandover): Tool<LiveInkContext> {
  return { id, begin: (sample, modifiers, context) => new LiveInk(sample, modifiers, context, handover) }
}
