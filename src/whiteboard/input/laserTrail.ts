import type { LaserContext, LaserPoint } from './basicTools'

export interface LaserTrailFrame { readonly points: readonly LaserPoint[]; readonly opacity: number }

// Ephemeral chrome only. The shared scheduler owns the clock and animation frames.
export class LaserTrail implements LaserContext {
  private points: LaserPoint[] = []
  private endedAt: number | null = null
  private visible = true
  constructor(private readonly now: () => number, private readonly invalidate: () => void, private readonly wakeAt: (deadline: number | null) => void, private readonly reducedMotion: () => boolean) {}
  append(point: LaserPoint): void {
    if (!this.visible) return
    this.endedAt = null
    this.points.push(point)
    if (this.points.length === 1) this.wakeAt(point.time + 2000)
    this.invalidate()
  }
  finish(): void {
    if (!this.points.length) return
    this.endedAt = this.now()
    this.wakeAt(this.endedAt + (this.reducedMotion() ? 2000 : 1500))
    this.invalidate()
  }
  cancel(): void { this.clear() }
  hide(): void { this.visible = false; this.clear() }
  show(): void { this.visible = true }
  frame(time: number): LaserTrailFrame | null {
    if (!this.visible || !this.points.length) return null
    if (this.endedAt !== null && time >= this.endedAt + 2000) { this.clear(); return null }
    if (this.endedAt === null) {
      let first = 0
      while (first < this.points.length && this.points[first].time + 2000 <= time) first++
      if (first) this.points = this.points.slice(first)
      if (!this.points.length) { this.wakeAt(null); return null }
      this.wakeAt(this.points[0].time + 2000)
    } else if (!this.reducedMotion() && time >= this.endedAt + 1500) this.wakeAt(Math.min(time + 16, this.endedAt + 2000))
    const opacity = this.endedAt === null || this.reducedMotion() ? 1 : Math.max(0, Math.min(1, (this.endedAt + 2000 - time) / 500))
    return { points: this.points, opacity }
  }
  private clear(): void {
    if (!this.points.length && this.endedAt === null) return
    this.points = []
    this.endedAt = null
    this.wakeAt(null)
    this.invalidate()
  }
}
