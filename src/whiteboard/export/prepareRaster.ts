import type { PathCommand } from '../../platform/types'
import type { PaintFrame, PaintItem } from '../render/paintStream'
import type { PaintImageLease, PaintImageProvider } from '../render/resources'
import { InkPath2dJob, Path2dJob } from '../render/reference/coverage2d'
import type { PaintResources2d, PreparedPath2d } from '../render/reference/paint2d'

export interface PreparedRaster {
  readonly resources: PaintResources2d
  /** Releases only leases held by this capture, not the source frame. */
  dispose(): void
}
function origin(commands: readonly PathCommand[]): readonly [number, number] {
  const first = commands[0]
  return first && first[0] !== 'Z' ? [first[1], first[2]] : [0, 0]
}
async function finishPath(job: Path2dJob | InkPath2dJob, signal: AbortSignal): Promise<PreparedPath2d> {
  try {
    while (job.step(1024) === 'pending') {
      signal.throwIfAborted()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal.throwIfAborted()
    const path = job.result
    if (!path) throw new Error('Export geometry cancelled')
    return { path, origin: job.origin }
  } catch (error) { job.cancel(); throw error }
}

/** Prepare the same 2D geometry and image leases as the screen painter. The frame is an
 * immutable capture, not a live scene: its owner must retain it until dispose. */
export async function prepareRaster(
  frame: PaintFrame, scale: number, images: PaintImageProvider, signal: AbortSignal,
): Promise<PreparedRaster> {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid export scale')
  const paths = new WeakMap<PaintItem, PreparedPath2d>()
  const clips = new Map<string, PreparedPath2d>()
  const geometry = new Map<string, PreparedPath2d>()
  const leases = new Map<string, PaintImageLease>()
  let disposed = false
  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const lease of leases.values()) lease.release()
    leases.clear()
    clips.clear()
    geometry.clear()
  }
  try {
    let count = 0
    for (const band of [frame.underlay, frame.content]) for (const item of band) {
      if (++count % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
      signal.throwIfAborted()
      for (const clip of item.clips) if (!clips.has(clip.key)) {
        clips.set(clip.key, await finishPath(new Path2dJob(clip.d, origin(clip.d)), signal))
      }
      if (item.kind === 'image') {
        if (!leases.has(item.imageKey)) {
          const lease = await images.acquire(item.imageKey, frame.token, signal)
          if (signal.aborted) { lease.release(); signal.throwIfAborted() }
          leases.set(item.imageKey, lease)
        }
      } else {
        const [a, b, c, d] = item.localToWorld
        const itemScale = Math.max(Number.MIN_VALUE, scale * Math.hypot(a, b, c, d))
        const key = `${item.kind}:${item.geometryKey}:${item.kind === 'ink' ? itemScale : ''}`
        let path = geometry.get(key)
        if (!path) {
          const job = item.kind === 'ink'
            ? new InkPath2dJob(item.coverage, itemScale, [item.coverage.boundsLocal.x, item.coverage.boundsLocal.y], Number.MAX_SAFE_INTEGER)
            : new Path2dJob(item.d, origin(item.d))
          path = await finishPath(job, signal)
          geometry.set(key, path)
        }
        paths.set(item, path)
      }
    }
    signal.throwIfAborted()
    return { resources: {
      path(item) { const value = paths.get(item); if (disposed || !value) throw new Error('Export path unavailable'); return value },
      clip(key) { const value = clips.get(key); if (disposed || !value) throw new Error('Export clip unavailable'); return value },
      image(key) { const value = leases.get(key); if (disposed || !value) throw new Error('Export image unavailable'); return value.source },
    }, dispose }
  } catch (error) { dispose(); throw error }
}
