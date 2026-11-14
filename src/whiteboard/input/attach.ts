import type { CameraController, Point } from '../../platform/render/camera'
import type { BoardSession } from '../session/BoardSession'
import { handTool, type HandContext } from './basicTools'
import { ToolState, type ToolStateSnapshot } from './gesture'
import { installKeyboard } from './keyboard'
import { LiveInk, WetInkHandover } from './liveInk'
import { installWheel, TouchArbiter, type ContactPoint } from './navigation'
import { MappingHistory } from './pointer'
import { PointerRouter, type PointerRoute } from './pointerRouter'
import { predictedTail, type PredictionMapping } from './prediction'
import { InputRouter } from './router'
import { sessionInkTool, type SessionInkServices } from './sessionInk'
import type { InputToken, Modifiers, RealSample, Tool } from './tool'

export type BoardInputMode = 'edit' | 'view'
export type Detach = () => void
export interface BoardWetLayer {
  attach(handover: WetInkHandover): Detach
  onInputFrame(callback: () => void): Detach
  invalidate(): void
}
export interface BoardInputView {
  readonly surface: HTMLElement
  readonly camera: CameraController
  readonly wet: BoardWetLayer
  readonly token: InputToken
  readonly mappings: MappingHistory
  readonly a11y: { toolState(snapshot: ToolStateSnapshot): void }
  readonly sampleToSurface: (sample: RealSample) => Point
  readonly clientToSurface: (x: number, y: number) => Point
  readonly predictionMapping: () => PredictionMapping
  readonly current: (token: InputToken) => boolean
  readonly visible: () => boolean
  readonly paged: boolean
}
export interface BoardInputServices {
  readonly tools: ToolState
  readonly history: { clearRedo(): void; undo(): void; redo(): void }
  readonly mac: boolean
  readonly shortcutsEnabled: () => boolean
  readonly modalOpen: () => boolean
  readonly editing: () => boolean
  readonly commands: { run(id: string, event: KeyboardEvent): boolean }
  ink(tool: 'pen' | 'highlighter', sample: RealSample): Omit<SessionInkServices, 'session' | 'tool' | 'clearRedoAtDown'>
  resolveTool(choice: ToolStateSnapshot['active'], sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<unknown> | null
  ownsWheel(event: WheelEvent): boolean
  cameraChanged(): void
  error(error: unknown): void
  contextMenu?(event: MouseEvent): void
  bindPenMode?(exit: () => void): Detach
  penModeChanged?(enabled: boolean): void
  clearLatches(): void
  cancelPendingGestures(): void
}

const attached = new WeakMap<HTMLElement, Detach>()
const gestureOwner = new WeakMap<BoardSession, symbol>()

// View generations own listeners only. The session owns history, gesture queue and
// tool choice; replacing a view first flushes its prefix, then installs a new one.
export function attachBoardInput(view: BoardInputView, session: BoardSession, services: BoardInputServices, mode: BoardInputMode): Detach {
  attached.get(view.surface)?.()
  const owner = Symbol('board-input-view')
  let live = true
  const current = () => live && view.visible() && view.current(view.token)
  const editable = () => mode === 'edit' && !session.isReadOnly
  const handover = new WetInkHandover()
  const router = new InputRouter<unknown>(() => session.beginGesture())
  let start: ToolStateSnapshot | null = null
  let activeSource: RealSample['source'] | null = null
  const touchAdmission = new Map<number, boolean>()
  const handContext: HandContext = {
    toSurface: view.sampleToSurface,
    panBy: delta => view.camera.panBy(delta),
    invalidate: services.cameraChanged,
  }
  const hand: Tool<unknown> = { id: handTool.id, begin: (sample, modifiers) => handTool.begin(sample, modifiers, handContext) }
  const ink = (id: 'pen' | 'highlighter'): Tool<unknown> => {
    const tool = sessionInkTool(id, handover)
    return { id, begin: (sample, modifiers) => tool.begin(sample, modifiers, { ...services.ink(id, sample), session, tool: id, clearRedoAtDown: () => services.history.clearRedo() }) }
  }
  const pointer = new PointerRouter<unknown>({
    root: view.surface, mappings: view.mappings, token: view.token, router, mac: services.mac, current,
    claim() {
      if (gestureOwner.has(session) || session.isGestureActive) return false
      gestureOwner.set(session, owner)
      return true
    },
    releaseClaim() { if (gestureOwner.get(session) === owner) gestureOwner.delete(session) },
    resolve(sample, modifiers, event) {
      if (!current() || (sample.source === 'touch' && !touchAdmission.get(sample.pointerId))) return null
      start = services.tools.getSnapshot()
      activeSource = sample.source
      const choice = start.active
      if (mode === 'view' || choice.id === 'hand') return { tool: hand, context: undefined }
      if (!editable()) return null
      if (choice.id === 'pen' || choice.id === 'highlighter') return { tool: ink(choice.id), context: undefined }
      return services.resolveTool(choice, sample, modifiers, event)
    },
    ended(reason) {
      if (reason === 'up' && start) services.tools.complete(start)
      start = null
      activeSource = null
    },
    prediction(id, event) {
      if (!current() || router.inkSuspended || !(router.activeOwner instanceof LiveInk) || !router.activeOwner.pointerIds.has(id)) return
      router.activeOwner.publishPrediction(event ? predictedTail(event, view.predictionMapping(), 16) : [])
      view.wet.invalidate()
    },
    contextMenu: services.contextMenu,
    error: services.error,
  })
  const touch = new TouchArbiter(view.camera, {
    cancelTouchPreview: () => { if (activeSource === 'touch') pointer.discardPreview() },
    endTouchCamera: services.cameraChanged,
    changed: services.cameraChanged,
    penModeChanged: enabled => services.penModeChanged?.(enabled),
  })
  const stopPenMode = services.bindPenMode?.(() => touch.exitPenMode())
  const contact = (event: PointerEvent): ContactPoint => ({ ...view.clientToSurface(event.clientX, event.clientY), id: event.pointerId, time: event.timeStamp, width: event.width, height: event.height })
  const down = (event: PointerEvent) => {
    if (!current()) return
    if (event.pointerType === 'pen') touch.penDown(event.pointerId, navigator.maxTouchPoints > 0)
    else if (event.pointerType === 'touch') {
      touchAdmission.set(event.pointerId, touch.touchDown(contact(event)))
      try { view.surface.setPointerCapture(event.pointerId) } catch { /* A later cancel ends the contact. */ }
    }
  }
  const move = (event: PointerEvent) => { if (current() && event.pointerType === 'touch') touch.touchMove(contact(event)) }
  const up = (event: PointerEvent) => {
    if (event.pointerType === 'pen') touch.penUp(event.pointerId, event.timeStamp)
    else if (event.pointerType === 'touch') { touch.touchUp(event.pointerId); touchAdmission.delete(event.pointerId) }
  }
  view.surface.addEventListener('pointerdown', down, true)
  view.surface.addEventListener('pointermove', move, true)
  view.surface.addEventListener('pointerup', up, true)
  view.surface.addEventListener('pointercancel', up, true)
  const stopWet = view.wet.attach(handover)
  const stopFrame = view.wet.onInputFrame(() => {
    if (current() && router.activeOwner instanceof LiveInk) router.activeOwner.publish()
  })
  const stopWheel = installWheel(view.surface, {
    camera: view.camera, paged: view.paged, toSurface: view.clientToSurface,
    owns: event => current() && services.ownsWheel(event),
    changed: () => { if (router.activeOwner instanceof LiveInk) router.activeOwner.publishPrediction([]); services.cameraChanged() },
  })
  const stopKeys = installKeyboard(view.surface, {
    visible: current, enabled: editable, shortcutsEnabled: services.shortcutsEnabled,
    modalOpen: services.modalOpen, editing: services.editing,
    modifierChanged: modifiers => pointer.modifiersChanged(modifiers),
    clearLatches: () => { router.resumeInk(view.token); services.clearLatches() }
    run(id, event) {
      if (!current()) return false
      if (id === 'escape') { services.cancelPendingGestures(); if (pointer.interrupt('escape')) return true }
      if (id === 'undo' && pointer.interrupt('undo')) return true
      if (id === 'undo' && editable()) { services.history.undo(); return true }
      if (id === 'redo' && editable()) { services.history.redo(); return true }
      if (id === 'tool.lock' && editable()) { services.tools.toggleLocked(); services.commands.run('tool.lock', event); return true }
      if (id === 'pan.hold' && router.activeOwner instanceof LiveInk) {
        let previous: Point
        return router.suspendInk(view.token, {
          begin: sample => { previous = view.sampleToSurface(sample) },
          update: samples => { for (const sample of samples) { const point = view.sampleToSurface(sample); view.camera.panBy({ x: previous.x - point.x, y: previous.y - point.y }); previous = point }; services.cameraChanged() },
          end: () => {},
        })
      }
      if (id === 'pan.release') router.resumeInk(view.token)
      if (id.startsWith('tool.') && editable()) {
        services.cancelPendingGestures()
        const tool = id.slice(5)
        if (services.tools.getRegistration(tool)) { services.tools.setTool(tool); return true }
      }
      return services.commands.run(id, event)
    },
  }, services.mac)
  let toolEpoch = services.tools.getSnapshot().selectionEpoch
  const updateMirror = () => {
    const snapshot = services.tools.getSnapshot()
    if (snapshot.selectionEpoch !== toolEpoch) {
      toolEpoch = snapshot.selectionEpoch
      services.cancelPendingGestures()
      pointer.interrupt('flush')
    }
    if (current()) view.a11y.toolState(snapshot)
  }
  const stopMirror = services.tools.subscribe(updateMirror)
  updateMirror()
  const detach = () => {
    if (!live) return
    services.cancelPendingGestures()
    pointer.dispose()
    live = false
    view.surface.removeEventListener('pointerdown', down, true)
    view.surface.removeEventListener('pointermove', move, true)
    view.surface.removeEventListener('pointerup', up, true)
    view.surface.removeEventListener('pointercancel', up, true)
    stopPenMode?.(); stopKeys(); stopWheel(); stopFrame(); stopMirror(); stopWet()
    if (attached.get(view.surface) === detach) attached.delete(view.surface)
    if (gestureOwner.get(session) === owner) gestureOwner.delete(session)
  }
  attached.set(view.surface, detach)
  return detach
}
