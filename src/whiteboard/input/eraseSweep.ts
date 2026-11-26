import type { NodeId } from '../model/ids'
import { isCancellation } from '../../platform/workers/envelope'

export interface ErasePoint { readonly x: number; readonly y: number }
export interface EraseSweepServices {
  /** The items the path touches on the board as it is now, bottom-most first. `points` are world points in order; one point
   * is a tap. It rejects with a cancellation when the board changed under the question, which is then asked again, and
   * reports any other failure of its own before rejecting with it. */
  touched(points: readonly ErasePoint[], signal: AbortSignal): Promise<readonly NodeId[]>
  /** Takes those items off the board now. Its failure is reported here. */
  erase(ids: readonly NodeId[], signal: AbortSignal): void | Promise<void>
  /** Resolves once the erase before this one has finished: two never work on the board at once. */
  readonly turn: Promise<void>
  now(): number
  wait(ms: number): Promise<void>
  error(error: unknown): void
}

/** The most path one question covers. A question's cost follows the box around its points, so a long one asked whole would
 * test every item in the box of a diagonal: a sweep that falls behind stays linear in its length this way. */
const BATCH_POINTS = 12
/** How long one stretch of path is asked again while the board keeps changing under the question (an edit landing from
 * elsewhere, fonts arriving). Each refusal waits for a real change, so this only ends a board that never comes to rest. */
const RETRY_MS = 15_000

/** The eraser's path, erased as it is drawn, in rounds: a round asks every stretch drawn since the last one against the board
 * as it is by then and takes what they touch off the board in one change. Nothing is kept to apply at the end, so a release has (at most) the last stretch still to ask, and a change to
 * the board in between costs that one stretch, never the whole path. Before, the path was kept whole, asked segment by
 * segment against one frozen revision and applied at release: any change restarted all of it, and the erase itself waited on
 * a preview frame that a 10,000-stroke board never presented (measured: 0 of 140 touched strokes erased, with no sign, 60 s
 * after the release).
 *
 * Top-most only (the person holds the accelerator with the Eraser): a stretch takes the item on top of what it touches, and
 * what lay under it is left alone for the rest of the gesture. Without that memory the next stretch, a pixel further on,
 * would find the item below on top and take it too: the eraser would dig through a pile one layer a step. */
export class EraseSweep {
  private readonly xs: number[] = []
  private readonly ys: number[] = []
  /** Whether the stretch ENDING at each point takes only the top-most item. */
  private readonly top: boolean[] = []
  /** Items a top-most stretch found under the item it took. */
  private readonly spared = new Set<NodeId>()
  /** Points whose stretch has been asked (and, once its round ends, erased). */
  private done = 0
  private running = false
  private stopped = false
  private closed = false
  /** The failure that ended the sweep was the question's, which reported it itself. */
  private asked = false
  private readonly controller = new AbortController()
  private resolve!: () => void
  readonly result: Promise<void>

  constructor(private readonly services: EraseSweepServices) {
    this.result = new Promise(resolve => { this.resolve = resolve })
  }

  /** Nothing of the path is waiting to be asked: a release now has nothing left to land. */
  get idle(): boolean { return !this.running && this.done >= this.xs.length }
  get signal(): AbortSignal { return this.controller.signal }

  add(point: ErasePoint, topOnly: boolean): void {
    if (this.stopped || this.closed) return
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid eraser point')
    const last = this.xs.length - 1
    // A pointer that has not moved adds nothing to ask (a held press repeats its point).
    if (last >= 0 && this.xs[last] === point.x && this.ys[last] === point.y) return
    this.xs.push(point.x); this.ys.push(point.y); this.top.push(topOnly)
    this.pump()
  }

  /** No more path will come. Resolves once all of it has been asked and erased, or the sweep was stopped. */
  finish(): Promise<void> {
    this.closed = true
    if (this.idle) this.resolve(); else this.pump()
    return this.result
  }

  /** Ends the sweep where it is: path not yet asked is dropped, and a question or an erase in flight comes to nothing. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true; this.closed = true
    this.controller.abort(new DOMException('Erase ended', 'AbortError'))
    this.resolve()
  }

  private pump(): void {
    if (this.running || this.stopped) return
    this.running = true
    void this.run().catch(error => {
      // The question reports its own failures; an erase's are ours to report. Either way the sweep ends here, and what it
      // already erased stays erased (the gesture's undo step holds it).
      if (!this.stopped && !this.asked && !isCancellation(error)) this.services.error(error)
      this.stop()
    }).finally(() => {
      this.running = false
      if (!this.stopped && this.done < this.xs.length) this.pump()
      else if (this.closed) this.resolve()
    })
  }

  private async run(): Promise<void> {
    await this.services.turn
    while (!this.stopped && this.done < this.xs.length) {
      // A round covers the path drawn up to now. Path drawn while it is asked waits for the next: a round that took it in
      // would never end under a pointer that keeps moving, and nothing would leave the board until it stopped.
      const end = this.xs.length, round = new Set<NodeId>()
      while (this.done < end) {
        // The stretch starts at the last point already asked, so the path between two questions is covered too.
        const from = Math.max(0, this.done - 1)
        const topOnly = this.top[this.done]
        // A top-most stretch is asked alone: "top-most" is per stretch of path, as it was pressed.
        let to = this.done
        if (!topOnly) while (to + 1 < end && to + 1 - from < BATCH_POINTS && !this.top[to + 1]) to++
        const points: ErasePoint[] = []
        for (let i = from; i <= to; i++) points.push({ x: this.xs[i], y: this.ys[i] })
        const ids = await this.ask(points)
        if (this.stopped) return
        this.take(ids, topOnly, round)
        this.done = to + 1
      }
      // One change a round. Rounds are not paced by the screen: waiting for the board to present each change before making
      // the next cost a 3,000-stroke board 50 to 100 ms of every erase (measured: shown 42 to 49 ms after the pointer's last
      // move, against at or before it), and a 10,000-stroke one, whose picture takes 160 to 880 ms, did not show them sooner.
      if (round.size) await this.services.erase([...round], this.controller.signal)
    }
  }

  private take(ids: readonly NodeId[], topOnly: boolean, round: Set<NodeId>): void {
    if (!topOnly) { for (const id of ids) round.add(id); return }
    const top = ids[ids.length - 1]
    // An item this gesture left alone is still on the board and on top here: it keeps what is under it.
    if (top === undefined || this.spared.has(top)) return
    round.add(top)
    for (let i = 0; i < ids.length - 1; i++) this.spared.add(ids[i])
  }

  private async ask(points: readonly ErasePoint[]): Promise<readonly NodeId[]> {
    const started = this.services.now()
    for (let attempt = 1; ; attempt++) {
      try { return await this.services.touched(points, this.controller.signal) }
      catch (error) {
        if (this.stopped) return []
        if (!isCancellation(error)) { this.asked = true; throw error }
        if (this.services.now() - started > RETRY_MS) throw new Error('The board kept changing, so the eraser stopped. What it had erased stays erased.')
        // A refusal follows a change that is still being absorbed: the next task or two usually finds the board ready.
        await this.services.wait(Math.min(48, attempt * 4))
        if (this.stopped) return []
      }
    }
  }
}
