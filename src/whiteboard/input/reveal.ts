import type { RevealBounds, RevealIdentity, RevealServices, SelectionReveal } from './revealTypes'

function valid(rect: RevealBounds): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0
}

// A newer selection cancels both an unresolved geometry reply and any old
// destination before visibility is considered. No independent animation clock.
export function createSelectionReveal(services: RevealServices): SelectionReveal {
  let sequence = 0
  let latest: RevealIdentity | null = null
  let disposed = false
  const request = (identity: RevealIdentity): void => {
    const serial = ++sequence
    latest = { token: { ...identity.token }, selection: identity.selection }
    const captured = latest
    if (disposed || !captured.selection || !services.current(captured)) return
    void Promise.resolve().then(() => services.bounds(captured)).then(bounds => {
      if (disposed || serial !== sequence || !services.current(captured) || !bounds) return
      const { camera, usable, direction } = services.presented()
      if (!valid(bounds) || !valid(usable) || usable.width === 0 || usable.height === 0 || !Number.isFinite(camera.z) || camera.z <= 0 || !Number.isFinite(camera.x) || !Number.isFinite(camera.y)) return
      const left = (bounds.x - camera.x) * camera.z, top = (bounds.y - camera.y) * camera.z
      const right = left + bounds.width * camera.z, bottom = top + bounds.height * camera.z
      const limitRight = usable.x + usable.width, limitBottom = usable.y + usable.height
      let sx = 0, sy = 0
      if (left >= usable.x && right <= limitRight && top >= usable.y && bottom <= limitBottom) return
      if (right - left > usable.width || bottom - top > usable.height) {
        sx = direction === 'rtl' ? limitRight - right : usable.x - left
        sy = usable.y - top
      } else {
        sx = left < usable.x ? usable.x - left : right > limitRight ? limitRight - right : 0
        sy = top < usable.y ? usable.y - top : bottom > limitBottom ? limitBottom - bottom : 0
      }
      if ((!sx && !sy) || disposed || serial !== sequence || !services.current(captured)) return
      services.camera.setCamera({ x: camera.x - sx / camera.z, y: camera.y - sy / camera.z, z: camera.z })
      services.changed()
    }).catch(error => { if (!disposed && serial === sequence) services.error?.(error) })
  }
  return {
    request,
    refresh: () => { if (latest) request(latest) },
    cancel: () => { sequence++; latest = null },
    dispose: () => { disposed = true; sequence++; latest = null },
  }
}
