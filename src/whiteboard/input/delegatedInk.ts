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
  get ready(): boolean { return !this.disabled && !!this.presenter && this.area.isConnected }

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
