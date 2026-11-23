import type { InputToken, Modifiers, RealSample } from './tool'

export interface KeyboardCursorPoint { readonly x: number; readonly y: number }
export interface KeyboardCursorServices {
  readonly token: InputToken
  current(token: InputToken): boolean
  toWorld(surface: KeyboardCursorPoint): KeyboardCursorPoint
  ensureVisible(surface: KeyboardCursorPoint): KeyboardCursorPoint
  show(point: KeyboardCursorPoint | null, activeGesture: boolean): void
  begin(sample: RealSample, modifiers: Modifiers): boolean
  update(sample: RealSample, modifiers: Modifiers): void
  finish(): void
  escape(): void
  undo(): void
}
export interface KeyboardCursor {
  readonly active: boolean
  /** A press is held at the cursor, begun by Enter or by the comma key. */
  readonly gesture: boolean
  currentSample(): RealSample | null
  activate(point: KeyboardCursorPoint): void
  move(dx: number, dy: number, coarse: boolean, modifiers: Modifiers): void
  enter(modifiers: Modifiers): boolean
  escape(): boolean
  undo(): boolean
  dispose(): void
}
