import type { CameraController, Point } from '../../platform/render/camera'
import type { BoardSession } from '../session/BoardSession'
import { TOOLS } from '../model/styles'
import type { Op } from '../change/ops'
import { handTool, type HandContext } from './basicTools'
import { ToolState, type ToolStateSnapshot } from './gesture'
import { installKeyboard } from './keyboard'
import { LiveInk, WetInkHandover } from './liveInk'
import { installWheel, TouchArbiter, type ContactPoint } from './navigation'
import { MappingHistory } from './pointer'
import { PointerRouter, type PointerRoute } from './pointerRouter'
import { predictedTail, type PredictedPoint, type PredictionMapping } from './prediction'
import { InputRouter } from './router'
import { sessionInkTool, type SessionInkServices } from './sessionInk'
import { zoomBrushTool, type ZoomBrushContext } from './zoomBrush'
import type { GestureOwner, InputToken, Modifiers, RealSample, Tool } from './tool'

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
  readonly isDirectPen: (event: PointerEvent) => boolean
  readonly commands: { run(id: string, event: KeyboardEvent): boolean }
  ink(tool: 'pen' | 'highlighter', sample: RealSample): Omit<SessionInkServices, 'session' | 'tool' | 'clearRedoAtDown'>
  resolveTool(choice: ToolStateSnapshot['active'], sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<unknown> | null
  zoomBrush(): ZoomBrushContext
  ownsWheel(event: WheelEvent): boolean
  cameraChanged(): void
  error(error: unknown): void
  pointerChanged?(sample: RealSample): void
  hover?(event: PointerEvent): void
  contextMenu?(event: MouseEvent): void
  linkAt?(sample: RealSample): (() => void) | null
  continueInk?(sample: RealSample): ((endpoint: RealSample) => boolean) | null
  bindPenMode?(exit: () => void): Detach
  penModeChanged?(enabled: boolean): void
  persistToolLock?(locked: boolean): void
  clearLatches(): void
  cancelPendingGestures(): boolean
}

const attached = new WeakMap<HTMLElement, Detach>()
const gestureOwner = new WeakMap<BoardSession, symbol>()
const sessionPenMode = new WeakMap<BoardSession, { enabled: boolean; listeners: Set<(enabled: boolean) => void> }>()

// View generations own listeners only. The session owns history, gesture queue and
// tool choice; replacing a view first flushes its prefix, then installs a new one.
export function attachBoardInput(view: BoardInputView, session: BoardSession, services: BoardInputServices, mode: BoardInputMode): Detach {
  attached.get(view.surface)?.()
  const owner = Symbol('board-input-view')
  let live = true
  let penMode = sessionPenMode.get(session)
  if (!penMode) { penMode = { enabled: false, listeners: new Set() }; sessionPenMode.set(session, penMode) }
  const sharedPenMode = penMode
  const current = () => live && view.visible() && view.current(view.token)
  const editable = () => mode === 'edit' && !session.isReadOnly
  const handover = new WetInkHandover()
  const router = new InputRouter<unknown>(() => session.beginGesture())
  let start: ToolStateSnapshot | null = null
  let activeSource: RealSample['source'] | null = null
  let completeTool = false
  let spaceHeld = false
  let zoomHeld = false
  let temporaryPan = false
  let pendingPrediction: readonly PredictedPoint[] | undefined
  let suppressMenu = false
  const touchAdmission = new Map<number, boolean>()
  const handContext: HandContext = {
    toSurface: view.sampleToSurface,
    panBy: delta => view.camera.panBy(delta),
    invalidate: services.cameraChanged,
  }
  const hand: Tool<unknown> = { id: handTool.id, begin: (sample, modifiers) => handTool.begin(sample, modifiers, handContext) }
  const secondaryPan: Tool<unknown> = {
    id: 'secondary-pan',
    begin(sample, modifiers) {
      const origin = view.sampleToSurface(sample)
      const pan = handTool.begin(sample, modifiers, handContext)
      if (!pan) return null
      let dragging = false
      const owner: GestureOwner = {
        kind: 'pan', pointerIds: pan.pointerIds,
        update(samples, nextModifiers) {
          for (const point of samples) {
            const surface = view.sampleToSurface(point)
            if (!dragging && Math.hypot(surface.x - origin.x, surface.y - origin.y) >= 4) { dragging = true; suppressMenu = true }
            if (dragging) pan.update([point], nextModifiers)
          }
        },
        finish: reason => pan.finish(reason), cancel: reason => pan.cancel(reason),
      }
      return owner
    },
  }
  const ink = (id: 'pen' | 'highlighter'): Tool<unknown> => {
    const tool = sessionInkTool(id, handover)
    return { id, begin: (sample, modifiers) => tool.begin(sample, modifiers, { ...services.ink(id, sample), session, tool: id, clearRedoAtDown: () => services.history.clearRedo() }) }
  }
  const pointer = new PointerRouter<unknown>({
    root: view.surface, mappings: view.mappings, token: view.token, router, mac: services.mac, current,
    sampleChanged: services.pointerChanged,
    hover: services.hover,
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
      completeTool = false
      if (event.button === 1) { event.preventDefault(); return { tool: hand, context: undefined } }
      if (event.button === 2 || (services.mac && event.button === 0 && event.ctrlKey)) { suppressMenu = false; return { tool: secondaryPan, context: undefined } }
      if (event.button !== 0) return null
      if (spaceHeld) { temporaryPan = true; return { tool: hand, context: undefined } }
      if (zoomHeld) {
        const context = services.zoomBrush()
        return { tool: { id: zoomBrushTool.id, begin: (point, keys) => zoomBrushTool.begin(point, keys, context) }, context: undefined }
      }
      if ((mode === 'view' || (editable() && choice.id === 'select')) && !modifiers.accel && !modifiers.alt && !modifiers.shift) {
        const open = services.linkAt?.(sample)
        if (open) {
          const origin = view.sampleToSurface(sample)
          const fallback = mode === 'view' ? { tool: hand, context: undefined } : services.resolveTool(choice, sample, modifiers, event)
          const link: Tool<unknown> = { id: 'view-link', begin: (_point, keys) => {
            let dragged = false
            let owner: GestureOwner | null = null
            return {
              kind: mode === 'view' ? 'pan' : 'node-edit', pointerIds: new Set([sample.pointerId]),
              update: (samples, nextKeys) => { for (const point of samples) {
                const next = view.sampleToSurface(point)
                if (!dragged && Math.hypot(next.x - origin.x, next.y - origin.y) >= 4) {
                  dragged = true
                  owner = fallback?.tool.begin(sample, keys, fallback.context) ?? null
                }
                if (dragged) owner?.update([point], nextKeys)
              } },
              finish: reason => { if (reason === 'up' && !dragged) open(); owner?.finish(reason) }, cancel: reason => owner?.cancel(reason),
            }
          } }
          return { tool: link, context: undefined }
        }
      }
      if (mode === 'view' || choice.id === 'hand') return { tool: hand, context: undefined }
      if (!editable()) return null
      completeTool = true
      if (choice.id === 'pen' && modifiers.shift) {
        const commit = services.continueInk?.(sample)
        if (commit) {
          const continuation: Tool<unknown> = { id: 'continue-ink', begin: () => {
            let endpoint = sample
            return { kind: 'node-edit', pointerIds: new Set([sample.pointerId]),
              update: samples => { if (samples.length) endpoint = samples[samples.length - 1] },
              finish: reason => { if (reason === 'up') commit(endpoint) }, cancel: () => {}, }
          } }
          return { tool: continuation, context: undefined }
        }
      }
      if (choice.id === 'pen' || choice.id === 'highlighter') return { tool: ink(choice.id), context: undefined }
      return services.resolveTool(choice, sample, modifiers, event)
    },
    ended(reason) {
      if (reason === 'up' && start && completeTool) services.tools.complete(start)
      completeTool = false
      temporaryPan = false
      pendingPrediction = undefined
      start = null
      activeSource = null
    },
    prediction(id, event) {
      if (!current() || router.inkSuspended || !(router.activeOwner instanceof LiveInk) || !router.activeOwner.pointerIds.has(id)) return
      pendingPrediction = event ? predictedTail(event, view.predictionMapping(), 16) : []
      view.wet.invalidate()
    },
    contextMenu: event => { if (suppressMenu) suppressMenu = false; else services.contextMenu?.(event) },
    error: services.error,
  })
  const touch = new TouchArbiter(view.camera, {
    cancelTouchPreview: () => { if (activeSource === 'touch') pointer.discardPreview() },
    endTouchCamera: services.cameraChanged,
    changed: services.cameraChanged,
    penModeChanged: enabled => {
      if (sharedPenMode.enabled === enabled) return
      sharedPenMode.enabled = enabled
      for (const listener of sharedPenMode.listeners) listener(enabled)
    },
  }, sharedPenMode.enabled)
  const onPenMode = (enabled: boolean) => { touch.setPenMode(enabled); services.penModeChanged?.(enabled) }
  sharedPenMode.listeners.add(onPenMode)
  services.penModeChanged?.(touch.penMode)
  const stopPenMode = services.bindPenMode?.(() => touch.exitPenMode())
  const contact = (event: PointerEvent): ContactPoint => ({ ...view.clientToSurface(event.clientX, event.clientY), id: event.pointerId, time: event.timeStamp, width: event.width, height: event.height })
  const down = (event: PointerEvent) => {
    if (!current()) return
    if (event.pointerType === 'pen') touch.penDown(event.pointerId, services.isDirectPen(event))
    else if (event.pointerType === 'touch') {
      touchAdmission.set(event.pointerId, touch.touchDown(contact(event)))
      try { view.surface.setPointerCapture(event.pointerId) } catch { /* A later cancel ends the contact. */ }
    }
  }
  const move = (event: PointerEvent) => {
    if (!current()) return
    if (event.pointerType === 'touch') touch.touchMove(contact(event))
    else if (event.pointerType === 'pen' && event.buttons === 0) touch.penHover(event.timeStamp)
  }
  const up = (event: PointerEvent) => {
    if (event.pointerType === 'pen') touch.penUp(event.pointerId, event.timeStamp)
    else if (event.pointerType === 'touch') { touch.touchUp(event.pointerId); touchAdmission.delete(event.pointerId) }
  }
  const auxclick = (event: MouseEvent) => { if (event.button === 1 || event.button === 2) event.preventDefault() }
  view.surface.addEventListener('auxclick', auxclick)
  view.surface.addEventListener('pointerdown', down, true)
  view.surface.addEventListener('pointermove', move, true)
  view.surface.addEventListener('pointerup', up, true)
  view.surface.addEventListener('pointercancel', up, true)
  view.surface.addEventListener('lostpointercapture', up, true)
  const stopWet = view.wet.attach(handover)
  const stopFrame = view.wet.onInputFrame(() => {
    if (current() && router.activeOwner instanceof LiveInk) {
      if (pendingPrediction) router.activeOwner.publishPrediction(pendingPrediction)
      else router.activeOwner.publish()
    }
    pendingPrediction = undefined
  })
  const stopWheel = installWheel(view.surface, {
    camera: view.camera, paged: view.paged, toSurface: view.clientToSurface,
    owns: event => current() && services.ownsWheel(event),
    changed: () => { if (router.activeOwner instanceof LiveInk) { pendingPrediction = []; view.wet.invalidate() }; services.cameraChanged() },
  })
  const stopKeys = installKeyboard(view.surface, {
    visible: current, enabled: editable, shortcutsEnabled: services.shortcutsEnabled,
    modalOpen: services.modalOpen, editing: services.editing,
    modifierChanged: modifiers => pointer.modifiersChanged(modifiers),
    clearLatches: () => { spaceHeld = false; zoomHeld = false; pointer.interrupt('flush'); services.clearLatches() },
    run(id, event) {
      if (!current()) return false
      if (id === 'escape') {
        const cancelled = services.cancelPendingGestures()
        if (pointer.interrupt('escape') || cancelled) return true
      }
      if (id === 'undo' && pointer.interrupt('undo')) return true
      if (id === 'undo' && editable()) { services.history.undo(); return true }
      if (id === 'redo' && editable()) { services.history.redo(); return true }
      if (id === 'tool.lock' && editable()) { services.tools.toggleLocked(); return true }
      if (id === 'pan.hold') {
        spaceHeld = true
        if (!(router.activeOwner instanceof LiveInk)) return true
        let previous: Point
        return router.suspendInk(view.token, {
          begin: sample => { previous = view.sampleToSurface(sample) },
          update: samples => { for (const sample of samples) { const point = view.sampleToSurface(sample); view.camera.panBy({ x: previous.x - point.x, y: previous.y - point.y }); previous = point }; services.cameraChanged() },
          end: () => {},
        })
      }
      if (id === 'pan.release') {
        spaceHeld = false
        router.resumeInk(view.token)
        if (temporaryPan) pointer.interrupt('flush')
        return true
      }
      if (id === 'zoom.hold') { zoomHeld = true; return true }
      if (id === 'zoom.release') { zoomHeld = false; return true }
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
    if (current() && editable()) {
      const ops: Op[] = []
      const tool = TOOLS.find(id => id === snapshot.active.id)
      if (tool && session.doc.ui.tool !== tool) ops.push({ t: 'board', key: 'ui.tool', value: tool })
      const lockChanged = session.doc.view.toolLock !== snapshot.locked
      if (lockChanged) ops.push({ t: 'board', key: 'view.toolLock', value: snapshot.locked })
      try {
        if (ops.length) session.apply({ origin: 'host', label: 'Tool state', ops }).release()
        if (lockChanged) services.persistToolLock?.(snapshot.locked)
      } catch (error) { services.error(error) }
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
    view.surface.removeEventListener('auxclick', auxclick)
    view.surface.removeEventListener('pointerdown', down, true)
    view.surface.removeEventListener('pointermove', move, true)
    view.surface.removeEventListener('pointerup', up, true)
    view.surface.removeEventListener('pointercancel', up, true)
    view.surface.removeEventListener('lostpointercapture', up, true)
    sharedPenMode.listeners.delete(onPenMode)
    stopPenMode?.(); stopKeys(); stopWheel(); stopFrame(); stopMirror(); stopWet()
    if (attached.get(view.surface) === detach) attached.delete(view.surface)
    if (gestureOwner.get(session) === owner) gestureOwner.delete(session)
  }
  attached.set(view.surface, detach)
  return detach
}
