// F-INPUT-001/004/005: tools receive normalized real input only.
export interface InputToken {
  readonly vaultEpoch: number
  readonly tabId: string
  readonly sessionGeneration: number
  readonly viewGeneration: number
}

export interface RealSample {
  readonly pointerId: number
  readonly sequence: number
  readonly source: 'pen' | 'touch' | 'mouse' | 'keyboard'
  readonly x: number
  readonly y: number
  /** Surface coordinates from the same presented mapping as x/y, never persisted. */
  readonly surfaceX?: number
  readonly surfaceY?: number
  readonly pressure: number
  readonly pressureKnown: boolean
  readonly time: number
  readonly buttons: number
  readonly tiltX: number
  readonly tiltY: number
  readonly twist: number
}

/** Physical samples carry their original surface mapping; keyboard samples use the current camera. */
export function sampleSurface(sample: RealSample, keyboard: (sample: RealSample) => { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } {
  if (sample.source === 'keyboard') return keyboard(sample)
  if (!Number.isFinite(sample.surfaceX) || !Number.isFinite(sample.surfaceY)) throw new Error('Physical sample has no presented surface mapping')
  return { x: sample.surfaceX!, y: sample.surfaceY! }
}

export interface Modifiers {
  readonly shift: boolean
  readonly alt: boolean
  readonly accel: boolean
  readonly control: boolean
}

export type GestureKind = 'ink' | 'erase' | 'laser' | 'node-edit' | 'pan' | 'pinch' | 'zoom-brush' | 'marquee'
export type FinishReason = 'up' | 'flush' | 'capture-lost' | 'os-cancel' | 'tool-change' | 'escape' | 'undo'
export type CancelReason = 'undo' | 'escape' | 'invalidated'

export interface GestureOwner {
  readonly pointerIds: ReadonlySet<number>
  readonly kind: GestureKind
  update(samples: readonly RealSample[], modifiers: Modifiers): void
  suspend?(): void
  discard?(): void
  finish(reason: FinishReason): void
  cancel(reason: CancelReason): void
}

// The host supplies commands and services through Context; tools never own the session or view.
export interface Tool<Context = unknown> {
  readonly id: string
  /** A view-only gesture (right-button pan) takes no session gesture hold, so the context menu its press
   * opens sees no "current gesture" and keeps Delete, Select all and Arrange enabled. */
  readonly holdsNoGesture?: boolean
  begin(sample: RealSample, modifiers: Modifiers, context: Context): GestureOwner | null
}

export function sameInputToken(a: InputToken, b: InputToken): boolean {
  return a.vaultEpoch === b.vaultEpoch && a.tabId === b.tabId &&
    a.sessionGeneration === b.sessionGeneration && a.viewGeneration === b.viewGeneration
}
