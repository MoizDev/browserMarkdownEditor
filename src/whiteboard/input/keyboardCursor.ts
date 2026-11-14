import type { KeyboardCursor, KeyboardCursorPoint, KeyboardCursorServices } from './keyboardCursorTypes'
import type { Modifiers, RealSample } from './tool'

// Keyboard input is an ordinary synthetic command sample, never a trusted pointer
// event and never an input to browser delegated-ink APIs.
export function createKeyboardCursor(services: KeyboardCursorServices): KeyboardCursor {
  let point: KeyboardCursorPoint | null = null
  let gesture = false
  let sequence = 0
  let disposed = false
  const current = () => !disposed && services.current(services.token)
  const sample = (): RealSample => {
    const world = services.toWorld(point!)
    return { pointerId: -1, sequence: ++sequence, source: 'keyboard', x: world.x, y: world.y,
      pressure: 0.5, pressureKnown: false, time: performance.now(), buttons: gesture ? 1 : 0, tiltX: 0, tiltY: 0, twist: 0 }
  }
  return {
    get active() { return current() && point !== null },
    activate(initial) {
      if (!current() || !Number.isFinite(initial.x) || !Number.isFinite(initial.y)) return
      if (gesture) { services.escape(); gesture = false }
      point = services.ensureVisible(initial)
      services.show(point, false)
    },
    move(dx, dy, coarse, modifiers) {
      if (!current() || !point || !Number.isFinite(dx) || !Number.isFinite(dy)) return
      const factor = coarse ? 10 : 1
      point = services.ensureVisible({ x: point.x + dx * factor, y: point.y + dy * factor })
      if (gesture) services.update(sample(), modifiers)
      services.show(point, gesture)
    },
    enter(modifiers) {
      if (!current() || !point) return false
      if (gesture) { services.finish(); gesture = false }
      else { gesture = true; if (!services.begin(sample(), modifiers)) gesture = false }
      services.show(point, gesture)
      return true
    },
    escape() {
      if (!current() || !point) return false
      if (gesture) { services.escape(); gesture = false; services.show(point, false) }
      else { point = null; services.show(null, false) }
      return true
    },
    undo() {
      if (!current() || !point || !gesture) return false
      services.undo(); gesture = false; services.show(point, false)
      return true
    },
    dispose() {
      if (disposed) return
      if (gesture) services.escape()
      disposed = true; gesture = false; point = null; services.show(null, false)
    },
  }
}
