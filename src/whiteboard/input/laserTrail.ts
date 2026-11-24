import type { LaserContext, LaserPoint } from './basicTools'

// Ephemeral chrome only: nothing here reaches the document, history or persistence. The shared scheduler owns the clock
// and the animation frames; `frame` is pure in its time argument.
export const LASER_IDLE_MS = 1200
export const LASER_FADE_MS = 500
/** A held stroke keeps only its newest points, so a long hold draws a bounded trail (the bound the trail had before sessions). */
const MAX_POINTS = 512

interface Session {
  readonly strokes: LaserPoint[][]
  /** A stroke of this session is being drawn: the session never stops while the pointer is down. */
  open: boolean
  /** The last pointer activity: a point's time while drawing, the release time after it. */
  activeAt: number
}

export interface LaserStroke { readonly points: readonly LaserPoint[] }

/** Strokes made within the idle timeout of each other share one session, and a session fades as one: once it has been idle
 * for `LASER_IDLE_MS`, every stroke loses its oldest points together on an ease-in curve over `LASER_FADE_MS`. Nothing
 * is faded per point, so a stroke cannot outlive the strokes it was drawn with. */
export class LaserTrail implements LaserContext {
  private sessions: Session[] = []
  private drawing: LaserPoint[] | null = null

  constructor(private readonly now: () => number) {}

  get active(): boolean { return this.sessions.length > 0 }

  append(point: LaserPoint): void {
    if (!this.drawing) {
      const last = this.sessions.at(-1)
      let session = last && point.time < last.activeAt + LASER_IDLE_MS ? last : undefined
      if (!session) { session = { strokes: [], open: false, activeAt: point.time }; this.sessions.push(session) }
      session.open = true; session.activeAt = point.time
      this.drawing = []; session.strokes.push(this.drawing)
    }
    this.drawing.push(point)
    if (this.drawing.length > MAX_POINTS) this.drawing.splice(0, this.drawing.length - MAX_POINTS)
    this.sessions.at(-1)!.activeAt = point.time
  }

  finish(): void {
    const session = this.sessions.at(-1)
    if (!this.drawing || !session) return
    this.drawing = null
    session.open = false
    session.activeAt = this.now()
  }

  cancel(): void { this.clear() }

  /** Drops every session at once; true when there was a trail to drop. */
  clear(): boolean {
    const had = this.sessions.length > 0
    this.sessions = []; this.drawing = null
    return had
  }

  /** The strokes still visible at `time`, faded sessions already trimmed. A finished session is dropped here. */
  frame(time: number): readonly LaserStroke[] {
    const out: LaserStroke[] = []
    this.sessions = this.sessions.filter(session => {
      const idleEnd = session.activeAt + LASER_IDLE_MS
      if (session.open || time < idleEnd) {
        for (const stroke of session.strokes) if (stroke.length) out.push({ points: stroke })
        return true
      }
      const progress = Math.min(1, (time - idleEnd) / LASER_FADE_MS)
      if (progress >= 1) return false
      const eased = progress * progress
      for (const stroke of session.strokes) {
        const removed = Math.floor(stroke.length * eased)
        if (removed < stroke.length) out.push({ points: removed ? stroke.slice(removed) : stroke })
      }
      return true
    })
    return out
  }
}
