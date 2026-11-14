export interface PredictedPoint {
  readonly x: number
  readonly y: number
  readonly time: number
}

export interface PredictionMapping {
  clientToSurface(x: number, y: number): { readonly x: number; readonly y: number }
  surfaceToWorld(x: number, y: number): { readonly x: number; readonly y: number }
  permits(x: number, y: number): boolean
}

// This transient tail is never fed to samples, hit testing, bounds or persistence.
export function predictedTail(event: PointerEvent, mapping: PredictionMapping, frameMs: number): readonly PredictedPoint[] {
  const getPredictedEvents = (event as PointerEvent & { getPredictedEvents?: () => PointerEvent[] }).getPredictedEvents
  if (!getPredictedEvents) return []
  let predicted: PointerEvent[]
  try { predicted = getPredictedEvents.call(event) } catch { return [] }
  const start = mapping.clientToSurface(event.clientX, event.clientY)
  if (![start.x, start.y, event.timeStamp].every(Number.isFinite)) return []
  const horizon = Math.max(0, Math.min(16, Number.isFinite(frameMs) ? frameMs : 0))
  const points: PredictedPoint[] = []
  let previousTime = event.timeStamp
  let previousX = start.x
  let previousY = start.y
  let directionX = 0
  let directionY = 0
  for (const item of predicted) {
    if (item.pointerId !== event.pointerId || !Number.isFinite(item.timeStamp) || item.timeStamp <= previousTime || item.timeStamp > event.timeStamp + horizon) break
    if (!Number.isFinite(item.clientX) || !Number.isFinite(item.clientY)) break
    const p = mapping.clientToSurface(item.clientX, item.clientY)
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.hypot(p.x - start.x, p.y - start.y) > 24 || !mapping.permits(p.x, p.y)) break
    const dx = p.x - previousX
    const dy = p.y - previousY
    if (directionX * dx + directionY * dy < 0) break
    const world = mapping.surfaceToWorld(p.x, p.y)
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) break
    points.push({ x: world.x, y: world.y, time: item.timeStamp })
    directionX = dx; directionY = dy
    previousX = p.x; previousY = p.y; previousTime = item.timeStamp
  }
  return points
}

interface InkPresenter {
  updateInkTrailStartPoint(event: PointerEvent, style: { diameter: number; color: string }): void
}
interface InkNavigator {
  ink?: { requestPresenter(options: { presentationArea: Element }): Promise<InkPresenter> }
}

// The presenter is view-local; failure never prevents ordinary rendering.
export class DelegatedInk {
  private presenter: InkPresenter | null = null
  private generation = 0
  private disabled = false
  constructor(private readonly area: HTMLElement) {}

  async attach(): Promise<void> {
    const generation = ++this.generation
    this.presenter = null
    this.disabled = false
    const ink = (navigator as Navigator & InkNavigator).ink
    if (!ink) return
    try {
      const presenter = await ink.requestPresenter({ presentationArea: this.area })
      if (generation === this.generation && this.area.isConnected) this.presenter = presenter
    } catch { if (generation === this.generation) this.disabled = true }
  }

  update(event: PointerEvent, diameter: number, color: string, eligible: boolean): boolean {
    if (!eligible || this.disabled || !this.presenter || !event.isTrusted || !this.area.isConnected || !Number.isFinite(diameter) || diameter <= 0) return false
    try { this.presenter.updateInkTrailStartPoint(event, { diameter, color }); return true }
    catch { this.presenter = null; this.disabled = true; return false }
  }

  detach(): void { this.generation++; this.presenter = null }
}
