import { sameInputToken, type CancelReason, type FinishReason, type GestureOwner, type InputToken, type Modifiers, type RealSample, type Tool } from './tool'

export interface InkPanSuspension {
  begin(anchor: RealSample): void
  update(samples: readonly RealSample[]): void
  end(): void
}

// One session owns the gesture; a replaced view cannot finish its successor's contact.
export class InputRouter<Context> {
  private token: InputToken | null = null
  private owner: GestureOwner | null = null
  private releaseHold: (() => void) | null = null
  private lastReal: RealSample | null = null
  private suspended: InkPanSuspension | null = null

  constructor(private readonly holdGesture: () => () => void = () => () => {}) {}

  attach(token: InputToken): void {
    if (this.token && !sameInputToken(this.token, token)) this.interrupt(this.token, 'flush')
    this.token = { ...token }
  }

  isCurrent(token: InputToken): boolean {
    return this.token !== null && sameInputToken(this.token, token)
  }

  detach(token: InputToken): void {
    if (!this.isCurrent(token)) return
    this.interrupt(token, 'flush')
    this.token = null
  }

  begin(token: InputToken, tool: Tool<Context>, sample: RealSample, modifiers: Modifiers, context: Context): boolean {
    if (!this.isCurrent(token) || this.owner) return false
    const release = this.holdGesture()
    try {
      const owner = tool.begin(sample, modifiers, context)
      if (!owner) { release(); return false }
      this.releaseHold = release
      this.owner = owner
      this.lastReal = sample
      return true
    } catch (error) { release(); throw error }
  }

  update(token: InputToken, pointerId: number, samples: readonly RealSample[], modifiers: Modifiers): void {
    if (!this.isCurrent(token) || !this.owner?.pointerIds.has(pointerId)) return
    if (samples.length) this.lastReal = samples[samples.length - 1]
    if (this.suspended) this.suspended.update(samples)
    else this.owner.update(samples, modifiers)
  }

  suspendInk(token: InputToken, pan: InkPanSuspension): boolean {
    if (!this.isCurrent(token) || this.owner?.kind !== 'ink' || !this.lastReal || this.suspended) return false
    pan.begin(this.lastReal)
    this.suspended = pan
    return true
  }

  resumeInk(token: InputToken): void {
    if (this.isCurrent(token)) this.endSuspension()
  }

  finish(token: InputToken, pointerId: number, reason: FinishReason): void {
    if (!this.isCurrent(token) || !this.owner?.pointerIds.has(pointerId)) return
    this.finishCurrent(reason)
  }

  cancel(token: InputToken, reason: CancelReason): void {
    if (!this.isCurrent(token) || !this.owner) return
    const owner = this.owner
    this.owner = null
    const release = this.takeRelease()
    try { owner.cancel(reason) } finally { release?.() }
  }

  // Undo/escape seal ink but discard reversible previews. The owner implements
  // the atomic finish-and-undo transaction for an ink undo.
  interrupt(token: InputToken, reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean {
    if (!this.isCurrent(token) || !this.owner) return false
    const owner = this.owner
    this.owner = null
    const release = this.takeRelease()
    try {
      if (owner.kind === 'ink') owner.finish(reason)
      else if (reason === 'flush' && (owner.kind === 'pan' || owner.kind === 'pinch' || owner.kind === 'zoom-brush' || owner.kind === 'laser')) owner.finish(reason)
      else owner.cancel(reason === 'undo' ? 'undo' : reason === 'escape' ? 'escape' : 'invalidated')
    } finally { release?.() }
    return true
  }

  get activeOwner(): GestureOwner | null { return this.owner }

  private finishCurrent(reason: FinishReason): void {
    const owner = this.owner
    this.owner = null
    const release = owner ? this.takeRelease() : null
    try { owner?.finish(reason) } finally { release?.() }
  }

  private endSuspension(): void {
    const pan = this.suspended
    this.suspended = null
    pan?.end()
  }

  private takeRelease(): (() => void) | null {
    this.endSuspension()
    this.lastReal = null
    const release = this.releaseHold
    this.releaseHold = null
    return release
  }
}
