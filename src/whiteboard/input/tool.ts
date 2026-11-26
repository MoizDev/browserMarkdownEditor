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
  /** On a press's first sample only: its place in a run of clicks (2 for a double-click), counted by `PointerAcquisition`. */
  readonly clicks?: number
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

/** How far a press may drift and still be a click, in CSS px. A person's click is never still:
 * measured, trackpad and mouse clicks drift 1-8 px over an 80-300 ms press, and at the old 4 px a
 * Note or Text click became a 2 px drag-created note and a click inside a selection became a move. */
export const CLICK_SLOP_CSS = 8
/** Presses within this time of the one before, close enough to it, make one run of clicks (the platforms' default double-click time). */
export const MULTI_CLICK_MS = 500
/** How far apart the presses of one run may land, by pointer: a pen's tip lands a few px off on every tap, a finger more. */
export const MULTI_CLICK_CSS: Readonly<Record<RealSample['source'], number>> = { mouse: CLICK_SLOP_CSS, pen: 16, touch: 24, keyboard: 0 }
