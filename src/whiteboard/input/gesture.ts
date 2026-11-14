import type { NodeId } from '../model/ids'

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
  private lastStroke: NodeId | null = null
  private lastPolyline: NodeId | null = null
  private inkSequence = 0
  private inputOwner: symbol | null = null
  private penModeValue = false
  private readonly penModeListeners = new Set<(enabled: boolean) => void>()
  private readonly penContacts = new Map<symbol, Map<number, number>>()
  private readonly penContactListeners = new Set<(id: number, down: boolean, direct: boolean, time: number) => void>()
  private penContactSequence = 0
  private documentSyncDepth = 0

  constructor(registrations: readonly ToolRegistration[], private readonly selectId = 'select', private readonly figureId = 'figure', initialLocked = false) {
    for (const registration of registrations) {
      if (!registration.id || this.registry.has(registration.id)) throw new Error(`Duplicate or empty tool id: ${registration.id}`)
      this.registry.set(registration.id, { ...registration })
    }
    if (!this.registry.has(selectId)) throw new Error('Select tool must be registered')
    this.snapshot = { active: { id: selectId }, locked: initialLocked, selectionEpoch: 0 }
  }

  getSnapshot = (): ToolStateSnapshot => this.snapshot
  get syncingDocument(): boolean { return this.documentSyncDepth > 0 }
  withDocumentSync<T>(action: () => T): T {
    this.documentSyncDepth++
    try { return action() } finally { this.documentSyncDepth-- }
  }
  get penMode(): boolean { return this.penModeValue }
  setPenMode(enabled: boolean): void {
    if (enabled === this.penModeValue) return
    this.penModeValue = enabled
    for (const listener of [...this.penModeListeners]) listener(enabled)
  }
  subscribePenMode(listener: (enabled: boolean) => void): () => void {
    this.penModeListeners.add(listener)
    return () => { this.penModeListeners.delete(listener) }
  }
  subscribePenContacts(listener: (id: number, down: boolean, direct: boolean, time: number) => void): () => void {
    this.penContactListeners.add(listener)
    for (const contacts of this.penContacts.values()) for (const id of contacts.values()) listener(id, true, false, 0)
    return () => { this.penContactListeners.delete(listener) }
  }
  penDown(owner: symbol, pointerId: number, direct: boolean, time: number): void {
    let contacts = this.penContacts.get(owner)
    if (!contacts) { contacts = new Map(); this.penContacts.set(owner, contacts) }
    if (contacts.has(pointerId)) return
    const id = this.penContactSequence + 1
    if (!Number.isSafeInteger(id)) throw new RangeError('Pen contact sequence exhausted')
    this.penContactSequence = id; contacts.set(pointerId, id)
    for (const listener of [...this.penContactListeners]) listener(id, true, direct, time)
  }
  penUp(owner: symbol, pointerId: number, time: number): void {
    const contacts = this.penContacts.get(owner), id = contacts?.get(pointerId)
    if (id === undefined) return
    contacts!.delete(pointerId)
    if (!contacts!.size) this.penContacts.delete(owner)
    for (const listener of [...this.penContactListeners]) listener(id, false, false, time)
  }
  releasePenOwner(owner: symbol, time: number): void {
    const contacts = this.penContacts.get(owner)
    if (!contacts) return
    this.penContacts.delete(owner)
    for (const id of contacts.values()) for (const listener of [...this.penContactListeners]) listener(id, false, false, time)
  }
  claimInput(owner: symbol, gestureActive: boolean): boolean {
    if (this.inputOwner || gestureActive) return false
    this.inputOwner = owner; return true
  }
  releaseInput(owner: symbol): void { if (this.inputOwner === owner) this.inputOwner = null }
  getLastStroke(): NodeId | null { return this.lastStroke }
  rememberStroke(id: NodeId): void { this.lastStroke = id }
  getLastPolyline(): NodeId | null { return this.lastPolyline }
  rememberPolyline(id: NodeId): void { this.lastPolyline = id }
  nextInkSequence(): number {
    const next = this.inkSequence + 1
    if (!Number.isSafeInteger(next)) throw new RangeError('Ink gesture sequence exhausted')
    this.inkSequence = next
    return next
  }

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
