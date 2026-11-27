import type { NodeId } from '../model/ids'
import { isCancellation } from '../../platform/workers/envelope'

export interface ErasePoint { readonly x: number; readonly y: number }
export interface EraseSweepServices {
  touched(points: readonly ErasePoint[], signal: AbortSignal): Promise<readonly NodeId[]>
  erase(ids: readonly NodeId[], signal: AbortSignal): void | Promise<void>
  readonly turn: Promise<void>
  now(): number
  wait(ms: number): Promise<void>
  error(error: unknown): void
}

const BATCH_POINTS = 12
const RETRY_MS = 15_000

export class EraseSweep {
  private readonly xs: number[] = []
  private readonly ys: number[] = []
  private readonly top: boolean[] = []
  private readonly spared = new Set<NodeId>()
  private done = 0
  private running = false
  private stopped = false
  private closed = false
  private asked = false
  private readonly controller = new AbortController()
  private resolve!: () => void
  readonly result: Promise<void>

  constructor(private readonly services: EraseSweepServices) {
    this.result = new Promise(resolve => { this.resolve = resolve })
  }

  get idle(): boolean { return !this.running && this.done >= this.xs.length }
  get signal(): AbortSignal { return this.controller.signal }

  add(point: ErasePoint, topOnly: boolean): void {
    if (this.stopped || this.closed) return
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid eraser point')
    const last = this.xs.length - 1
    if (last >= 0 && this.xs[last] === point.x && this.ys[last] === point.y) return
    this.xs.push(point.x); this.ys.push(point.y); this.top.push(topOnly)
    this.pump()
  }

  finish(): Promise<void> {
    this.closed = true
    if (this.idle) this.resolve(); else this.pump()
    return this.result
  }

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
      const end = this.xs.length, round = new Set<NodeId>()
      while (this.done < end) {
        const from = Math.max(0, this.done - 1)
        const topOnly = this.top[this.done]
        let to = this.done
        if (!topOnly) while (to + 1 < end && to + 1 - from < BATCH_POINTS && !this.top[to + 1]) to++
        const points: ErasePoint[] = []
        for (let i = from; i <= to; i++) points.push({ x: this.xs[i], y: this.ys[i] })
        const ids = await this.ask(points)
        if (this.stopped) return
        this.take(ids, topOnly, round)
        this.done = to + 1
      }
      if (round.size) await this.services.erase([...round], this.controller.signal)
    }
  }

  private take(ids: readonly NodeId[], topOnly: boolean, round: Set<NodeId>): void {
    if (!topOnly) { for (const id of ids) round.add(id); return }
    const top = ids[ids.length - 1]
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
        await this.services.wait(Math.min(48, attempt * 4))
        if (this.stopped) return []
      }
    }
  }
}
