// Tool choice is session UI state, not document history. Tool implementations and
// their command services are registered by the host, not imported by the router.
export interface ToolRegistration {
  readonly id: string
  readonly persistence: 'persistent' | 'single-use'
  readonly hasVariants?: boolean
}

export interface ToolChoice {
  readonly id: string
  readonly variant?: string
}

export interface ToolStateSnapshot {
  readonly active: ToolChoice
  readonly locked: boolean
  readonly lastFigure?: string
  readonly selectionEpoch: number
}

export class ToolState {
  private readonly registry = new Map<string, ToolRegistration>()
  private readonly listeners = new Set<() => void>()
  private snapshot: ToolStateSnapshot

  constructor(registrations: readonly ToolRegistration[], private readonly selectId = 'select', private readonly figureId = 'figure') {
    for (const registration of registrations) {
      if (!registration.id || this.registry.has(registration.id)) throw new Error(`Duplicate or empty tool id: ${registration.id}`)
      this.registry.set(registration.id, { ...registration })
    }
    if (!this.registry.has(selectId)) throw new Error('Select tool must be registered')
    this.snapshot = { active: { id: selectId }, locked: false, selectionEpoch: 0 }
  }

  getSnapshot = (): ToolStateSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getRegistration(id: string): Readonly<ToolRegistration> | undefined {
    return this.registry.get(id)
  }

  setTool(id: string, variant?: string): void {
    const registration = this.registry.get(id)
    if (!registration) throw new Error(`Unknown tool: ${id}`)
    if (variant !== undefined && !registration.hasVariants) throw new Error(`Tool has no variants: ${id}`)
    const lastFigure = id === this.figureId && variant !== undefined ? variant : this.snapshot.lastFigure
    if (this.snapshot.active.id === id && this.snapshot.active.variant === variant && this.snapshot.lastFigure === lastFigure) return
    this.publish({ ...this.snapshot, active: { id, ...(variant !== undefined ? { variant } : {}) }, lastFigure, selectionEpoch: this.snapshot.selectionEpoch + 1 })
  }

  setLocked(locked: boolean): void {
    if (this.snapshot.locked !== locked) this.publish({ ...this.snapshot, locked })
  }

  toggleLocked(): void { this.setLocked(!this.snapshot.locked) }

  // A stale completion must not switch away from a tool chosen during the gesture.
  complete(start: ToolStateSnapshot): void {
    if (this.snapshot.selectionEpoch !== start.selectionEpoch || this.snapshot.locked) return
    if (this.registry.get(start.active.id)?.persistence === 'single-use') this.setTool(this.selectId)
  }

  escape(): void { this.setTool(this.selectId) }

  private publish(snapshot: ToolStateSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
