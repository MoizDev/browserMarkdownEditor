import type { Modifiers } from './tool'

export const MODIFIER_RELEASE_MS = 150

const FLAGS: readonly (keyof Modifiers)[] = ['shift', 'alt', 'accel', 'control']

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
