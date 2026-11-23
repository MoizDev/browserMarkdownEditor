import type { Modifiers } from './tool'

/** Shift, Alt, Ctrl and Cmd stay held for 150 ms after their key-up, so a key released just before a new interaction
 * never counts as held at its start. Any pointer-down flushes pending releases at once. Catalogue I§1.4. */
export const MODIFIER_RELEASE_MS = 150

const FLAGS: readonly (keyof Modifiers)[] = ['shift', 'alt', 'accel', 'control']

/** Keyboard-reported modifiers, with each release debounced. Presses are immediate. */
export class ModifierRelease {
  private held: Modifiers = { shift: false, alt: false, accel: false, control: false }
  private readonly timers = new Map<keyof Modifiers, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly emit: (modifiers: Modifiers) => void) {}

  update(reported: Modifiers): void {
    if (this.disposed) return
    let changed = false
    for (const flag of FLAGS) {
      if (reported[flag]) {
        this.cancelRelease(flag)
        if (!this.held[flag]) { this.held = { ...this.held, [flag]: true }; changed = true }
      } else if (this.held[flag] && !this.timers.has(flag)) {
        this.timers.set(flag, setTimeout(() => {
          this.timers.delete(flag)
          this.release(flag)
        }, MODIFIER_RELEASE_MS))
      }
    }
    if (changed) this.emit(this.held)
  }

  /** Pointer-down: pending releases land now, so the new interaction starts from what is physically held. */
  flush(): void {
    if (this.disposed) return
    let changed = false
    for (const flag of FLAGS) {
      if (!this.timers.has(flag)) continue
      this.cancelRelease(flag)
      if (this.held[flag]) { this.held = { ...this.held, [flag]: false }; changed = true }
    }
    if (changed) this.emit(this.held)
  }

  /** Blur or a cleared latch: every modifier is released now. */
  releaseAll(): void {
    if (this.disposed) return
    let changed = false
    for (const flag of FLAGS) {
      this.cancelRelease(flag)
      if (this.held[flag]) { this.held = { ...this.held, [flag]: false }; changed = true }
    }
    if (changed) this.emit(this.held)
  }

  dispose(): void {
    if (this.disposed) return
    for (const flag of FLAGS) this.cancelRelease(flag)
    this.disposed = true
  }

  private release(flag: keyof Modifiers): void {
    if (!this.held[flag]) return
    this.held = { ...this.held, [flag]: false }
    this.emit(this.held)
  }

  private cancelRelease(flag: keyof Modifiers): void {
    const timer = this.timers.get(flag)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(flag)
  }
}
