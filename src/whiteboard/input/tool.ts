// F-INPUT-001/004/005: tools receive normalized real input, never browser predictions.
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
  readonly pressure: number
  readonly pressureKnown: boolean
  readonly time: number
  readonly buttons: number
  readonly tiltX: number
  readonly tiltY: number
  readonly twist: number
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
  finish(reason: FinishReason): void
  cancel(reason: CancelReason): void
}

// The host supplies commands and services through Context; tools never own the session or view.
export interface Tool<Context = unknown> {
  readonly id: string
  begin(sample: RealSample, modifiers: Modifiers, context: Context): GestureOwner | null
}

export function sameInputToken(a: InputToken, b: InputToken): boolean {
  return a.vaultEpoch === b.vaultEpoch && a.tabId === b.tabId &&
    a.sessionGeneration === b.sessionGeneration && a.viewGeneration === b.viewGeneration
}
