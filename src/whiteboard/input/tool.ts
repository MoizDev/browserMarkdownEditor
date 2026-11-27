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
  readonly surfaceX?: number
  readonly surfaceY?: number
  readonly pressure: number
  readonly pressureKnown: boolean
  readonly time: number
  readonly buttons: number
  readonly tiltX: number
  readonly tiltY: number
  readonly twist: number
  readonly clicks?: number
}

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

export interface Tool<Context = unknown> {
  readonly id: string
  readonly holdsNoGesture?: boolean
  begin(sample: RealSample, modifiers: Modifiers, context: Context): GestureOwner | null
}

export function sameInputToken(a: InputToken, b: InputToken): boolean {
  return a.vaultEpoch === b.vaultEpoch && a.tabId === b.tabId &&
    a.sessionGeneration === b.sessionGeneration && a.viewGeneration === b.viewGeneration
}

export const CLICK_SLOP_CSS = 8
export const MULTI_CLICK_MS = 500
export const MULTI_CLICK_CSS: Readonly<Record<RealSample['source'], number>> = { mouse: CLICK_SLOP_CSS, pen: 16, touch: 24, keyboard: 0 }
