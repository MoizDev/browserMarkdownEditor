import type { RealSample } from './tool'
import type { PredictedPoint } from './prediction'

export interface LiveTail {
  readonly pointerId: number
  readonly real: RealSample
  readonly predicted: readonly PredictedPoint[]
}

// The scheduler calls drain in its input phase. Real samples are appended by the
// gesture as they arrive; only this presentation snapshot is frame-coalesced.
export class InputFrameTail {
  private tail: LiveTail | null = null
  private dirty = false
  constructor(private readonly invalidate: (reason: string) => void) {}

  updateReal(real: RealSample): void {
    this.tail = { pointerId: real.pointerId, real, predicted: [] }
    this.request()
  }

  updatePrediction(pointerId: number, predicted: readonly PredictedPoint[]): void {
    if (!this.tail || this.tail.pointerId !== pointerId) return
    this.tail = { ...this.tail, predicted: [...predicted] }
    this.request()
  }

  clear(pointerId: number): void {
    if (this.tail?.pointerId !== pointerId) return
    this.tail = null
    this.request()
  }

  drain(publish: (tail: LiveTail | null) => void): void {
    if (!this.dirty) return
    this.dirty = false
    publish(this.tail)
  }

  private request(): void {
    if (this.dirty) return
    this.dirty = true
    this.invalidate('input-tail')
  }
}
