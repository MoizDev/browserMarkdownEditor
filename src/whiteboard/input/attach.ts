import { surfaceToWorld, type CameraController, type Point } from '../../platform/render/camera'
import type { TouchPanSample } from '../../platform/render/scheduler'
import type { BoardSession } from '../session/BoardSession'
import { TOOLS } from '../model/styles'
import type { Op } from '../change/ops'
import { handTool, type HandContext } from './basicTools'
import { ToolState, type ToolStateSnapshot } from './gesture'
import { installKeyboard } from './keyboard'
import { createKeyboardCursor } from './keyboardCursor'
import { LiveInk, WetInkHandover } from './liveInk'
import { InkContinuationGesture } from './continueInkGesture'
import type { InkContinuation } from './continueInk'
import { installWheel, TouchArbiter, type ContactPoint } from './navigation'
import { MappingHistory } from './pointer'
import { PointerRouter, type PointerRoute } from './pointerRouter'
import { EdgeScroll } from './edgeScroll'
import { TouchDoubleTap } from './touchDoubleTap'
import { DelegatedInkBridge, type PresentedWetSample } from './delegatedBridge'
import { InputRouter } from './router'
import { sessionInkTool, type SessionInkServices } from './sessionInk'
import { zoomBrushTool, type ZoomBrushContext } from './zoomBrush'
import { QuickOverview } from './quickOverview'
import { sampleSurface, type GestureOwner, type InputToken, type Modifiers, type RealSample, type Tool } from './tool'
import type { KeyboardNavigationPriority } from './scrollKeysTypes'
import type { TextInputBridge } from '../text/edit/managerTypes'

export type BoardInputMode = 'edit' | 'view'
export type Detach = () => void
export interface BoardWetLayer {
  attach(handover: WetInkHandover): Detach
  onInputFrame(callback: () => void): Detach
  /** Fires only after this exact real wet curve has been presented. */
  onRealPresented?(callback: (sample: PresentedWetSample) => void): Detach
  invalidate(): void
}
export interface BoardInputView {
  readonly surface: HTMLElement
  readonly camera: CameraController
  readonly wet: BoardWetLayer
  readonly token: InputToken
  readonly mappings: MappingHistory
  readonly a11y: { toolState(snapshot: ToolStateSnapshot): void; bindKeyboardCursor?(activate: () => void): Detach; keyboardCursor?(point: Point | null, activeGesture: boolean): void; repeatAnnouncement?(): boolean }
  readonly bindFlush?: (flush: () => void) => Detach
  readonly sampleToSurface: (sample: RealSample) => Point
  readonly clientToSurface: (x: number, y: number) => Point
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
  readonly textInput?: TextInputBridge
  readonly isDirectPen: (event: PointerEvent) => boolean
  readonly commands: { run(id: string, event: KeyboardEvent): boolean }
  ink(tool: 'pen' | 'highlighter', sample: RealSample): Omit<SessionInkServices, 'session' | 'tool' | 'clearRedoAtDown'>
  resolveTool(choice: ToolStateSnapshot['active'], sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<unknown> | null
  zoomBrush(): ZoomBrushContext
  keyboardCursorInitial?(): Point
  keyboardCursorVisible?(point: Point): Point
  resolveKeyboardTool?(choice: ToolStateSnapshot['active'], sample: RealSample, modifiers: Modifiers): PointerRoute<unknown> | null
  keyboardHandleCommand?(id: string, sample: RealSample): boolean
  keyboardContextMenu?(surface: Point, world: Point): boolean
  handleDoubleClick?(surface: Point, world: Point, time: number): boolean
  keyboardNavigation?(keyboardCursorActive: boolean): KeyboardNavigationPriority
  ownsWheel(event: WheelEvent): boolean
  cameraChanged(): void
  startFling?(samples: readonly TouchPanSample[]): void
  cancelMotion?(): void
  edgeScrolling?(): boolean
  invertMouseZoom?(): boolean
  error(error: unknown): void
  pointerChanged?(sample: RealSample): void
  hover?(event: PointerEvent): void
  contextMenu?(event: MouseEvent): void
  drop?(event: DragEvent): void
  linkAt?(sample: RealSample): (() => void) | null
  continueInk?(sample: RealSample): InkContinuation | null
  bindPenMode?(exit: () => void): Detach
  penModeChanged?(enabled: boolean): void
  persistToolLock?(locked: boolean): void
  clearLatches?(): void
  cancelPendingGestures(): boolean
}

const attached = new WeakMap<HTMLElement, Detach>()

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
  let completeTool = false
  /** The tool the stylus eraser end displaced; it returns when that end lifts (F-INPUT-009). */
  let restoreTool: string | null = null
  let spaceHeld = false
  let zoomHeld = false
  // F-TOOL-009: the quick overview is Shift pressed while Z is held. Shift pressed first is the direct zoom route, not this.
  let shiftHeld = false
  const overview = new QuickOverview(() => services.zoomBrush())
  const trackShift = (held: boolean) => {
    if (held === shiftHeld) return
    shiftHeld = held
    if (!zoomHeld) return
    if (held) { if (!router.activeOwner) overview.enter() } else overview.leave()
  }
  let temporaryPan = false
  /** A right (or Ctrl) press in progress: its native menu is the app's to decide, on release, once it is known to be a click (F-INPUT-012). */
  let rightPressActive = false
  const touchAdmission = new Map<number, boolean>()
  const pendingContinuations = new Set<() => void>()
  const cancelContinuations = (): boolean => {
    const pending = [...pendingContinuations]
    for (const cancel of pending) {
      try { cancel() } catch (error) { try { services.error(error) } catch { /* Keep cancelling the remaining work. */ } }
    }
    return pending.length > 0
  }
  const physicalSurface = (sample: RealSample) => sampleSurface(sample, view.sampleToSurface)
  const handContext: HandContext = {
    toSurface: physicalSurface,
    panBy: delta => view.camera.panBy(delta),
    invalidate: services.cameraChanged,
    startFling: services.startFling,
  }
  const hand: Tool<unknown> = { id: handTool.id, begin: (sample, modifiers) => handTool.begin(sample, modifiers, handContext) }
  // Right-button drag pans and never opens a menu on release; a stationary press opens the board menu on release (F-INPUT-012).
  const secondaryPan: Tool<PointerEvent | undefined> = {
    id: 'secondary-pan', holdsNoGesture: true,
    begin(sample, modifiers, press) {
      const origin = physicalSurface(sample)
      const pan = handTool.begin(sample, modifiers, { ...handContext, flingEnabled: true })
      if (!pan) return null
      rightPressActive = true
      let dragging = false
      const release = () => { rightPressActive = false }
      const owner: GestureOwner = {
        kind: 'pan', pointerIds: pan.pointerIds,
        update(samples, nextModifiers) {
          for (const point of samples) {
            const surface = physicalSurface(point)
            if (!dragging && Math.hypot(surface.x - origin.x, surface.y - origin.y) >= 4) dragging = true
            if (dragging) pan.update([point], nextModifiers)
          }
        },
        finish(reason) {
          pan.finish(reason); release()
          if (reason === 'up' && !dragging && press) services.contextMenu?.(press)
        },
        cancel(reason) { pan.cancel(reason); release() },
      }
      return owner
    },
  }
  const ink = (id: 'pen' | 'highlighter'): Tool<unknown> => {
    const tool = sessionInkTool(id, handover)
    return { id, begin: (sample, modifiers) => tool.begin(sample, modifiers, { ...services.ink(id, sample), session, tool: id, clearRedoAtDown: () => services.history.clearRedo() }) }
  }
  const continuationTool = (sample: RealSample, plan: InkContinuation): Tool<unknown> => ({
    id: 'continue-ink', begin: () => new InkContinuationGesture(sample, plan, {
      session, handover, invalidate: () => view.wet.invalidate(), error: services.error,
      registerPending(cancel) { pendingContinuations.add(cancel); return () => { pendingContinuations.delete(cancel) } },
    }),
  })
  const claim = (): boolean => services.tools.claimInput(owner, session.isGestureActive)
  const releaseClaim = (): void => { services.tools.releaseInput(owner) }
  const delegated = session.doc.kind === 'whiteboard' && view.wet.onRealPresented ? new DelegatedInkBridge({
    surface: view.surface, mappings: view.mappings, camera: () => view.camera.camera, current,
    onRealPresented: callback => view.wet.onRealPresented!(callback),
  }) : null
  const edgeScroll = new EdgeScroll({ surface: view.surface, camera: view.camera, mappings: view.mappings, router, token: view.token,
    mac: services.mac, current, enabled: () => services.edgeScrolling?.() ?? true, cameraChanged: services.cameraChanged,
    onInputFrame: callback => view.wet.onInputFrame(callback), invalidate: () => view.wet.invalidate() })
  const pointer = new PointerRouter<unknown>({
    root: view.surface, mappings: view.mappings, token: view.token, router, mac: services.mac, current,
    sampleChanged: sample => { edgeScroll.sample(sample); services.pointerChanged?.(sample) },
    realEvent: (sample, event) => delegated?.observe(event, sample),
    penTransitions: () => { const id = services.tools.getSnapshot().active.id; return id === 'pen' || id === 'highlighter' },
    settled: signal => session.enqueueAfterGesture(signal, () => undefined),
    cancelPending: services.cancelPendingGestures,
    hover: services.hover,
    claim, releaseClaim,
    resolve(sample, modifiers, event) {
      if (!current() || (sample.source === 'touch' && !touchAdmission.get(sample.pointerId))) return null
      start = services.tools.getSnapshot()
      activeSource = sample.source
      const choice = start.active
      completeTool = false
      if (sample.source === 'pen' && ((event.type === 'pointerdown' && event.button === 5) || (sample.buttons & 32) !== 0)) {
        if (!editable()) return null
        // Eraser-end selects Eraser for as long as it is held, separately from the E key and the right button.
        if (start.active.id !== 'eraser' && services.tools.getRegistration('eraser')) { restoreTool = start.active.id; services.tools.setTool('eraser') }
        return services.resolveTool({ id: 'eraser' }, sample, modifiers, event)
      }
      if (event.type === 'pointerdown' && event.button === 1) { event.preventDefault(); return { tool: hand, context: undefined } }
      if (event.type === 'pointerdown' && (event.button === 2 || (services.mac && event.button === 0 && event.ctrlKey))) {
        // A barrel press while the pen is drawing belongs to that stroke: no pan, no menu (F-INPUT-008).
        if (activeSource === 'pen' && event.button === 2) return null
        return { tool: secondaryPan, context: event }
      }
      if (event.type === 'pointerdown' && event.button !== 0) return null
      if (spaceHeld) { temporaryPan = true; return { tool: hand, context: undefined } }
      if (zoomHeld) {
        // The overview's press lands the destination and returns to Draw while Z is still held: no gesture follows.
        if (overview.active) { overview.leave(); zoomHeld = false; return null }
        const source = services.zoomBrush()
        const context = { ...source, toSurface: (point: RealSample) => sampleSurface(point, source.toSurface) }
        return { tool: { id: zoomBrushTool.id, begin: (point, keys) => zoomBrushTool.begin(point, keys, context) }, context: undefined }
      }
      if (editable() && services.editing() && services.textInput) {
        const textRoute = services.textInput.pointer(sample, modifiers, event)
        if (textRoute) return textRoute
      }
      if ((mode === 'view' || (editable() && choice.id === 'select')) && !modifiers.accel && !modifiers.alt && !modifiers.shift) {
        const open = services.linkAt?.(sample)
        if (open) {
          const origin = physicalSurface(sample)
          const fallback = mode === 'view' ? { tool: hand, context: undefined } : services.resolveTool(choice, sample, modifiers, event)
          const link: Tool<unknown> = { id: 'view-link', begin: (_point, keys) => {
            let dragged = false
            let owner: GestureOwner | null = null
            return {
              kind: mode === 'view' ? 'pan' : 'node-edit', pointerIds: new Set([sample.pointerId]),
              update: (samples, nextKeys) => { for (const point of samples) {
                const next = physicalSurface(point)
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
        if (commit) return { tool: continuationTool(sample, commit), context: undefined }
      }
      if (choice.id === 'pen' || choice.id === 'highlighter') return { tool: ink(choice.id), context: undefined }
      const routed = services.resolveTool(choice, sample, modifiers, event)
      // A creation's commit is still running after up; the single-use return to Select writes ui.tool,
      // which bumps the revision and cancels pending gestures, so it would abort that commit.
      if (routed?.completesTool) completeTool = false
      return routed
    },
    ended(reason) {
      delegated?.clear()
      // A non-editable view must not write the single-use reset: complete() can persist ui.tool to the shared document.
      if (reason === 'up' && start && completeTool && editable()) services.tools.complete(start)
      completeTool = false
      if (restoreTool !== null && editable() && services.tools.getRegistration(restoreTool)) services.tools.setTool(restoreTool)
      restoreTool = null
      temporaryPan = false
      start = null
      activeSource = null
    },
    // The native menu is always replaced. A mouse-originated one (a right or Ctrl press) is decided by the press itself;
    // only a keyboard-raised one opens the board menu directly.
    contextMenu: event => { event.preventDefault(); if (!rightPressActive && event.button !== 2 && !event.ctrlKey) services.contextMenu?.(event) },
    error: services.error,
  })
  let cancelKeyboardGesture = () => false
  let dismissKeyboardCursor = () => {}
  const cancelForCamera = () => {
    cancelContinuations(); services.cancelPendingGestures()
    const active = router.activeOwner
    if (!active || !['node-edit', 'erase', 'marquee', 'zoom-brush'].includes(active.kind)) return
    if (active.pointerIds.has(-1)) cancelKeyboardGesture()
    else pointer.interrupt('os-cancel')
  }
  const touch = new TouchArbiter(view.camera, {
    cancelTouchPreview: () => { if (activeSource === 'touch') pointer.discardPreview() },
    endTouchCamera: services.cameraChanged,
    changed: () => { cancelForCamera(); services.cameraChanged() },
    penModeChanged: enabled => services.tools.setPenMode(enabled),
  }, services.tools.penMode)
  const onPenMode = (enabled: boolean) => {
    try { touch.setPenMode(enabled); services.penModeChanged?.(enabled) }
    catch (error) { try { services.error(error) } catch { /* Other views must still receive the state. */ } }
  }
  const stopSharedPenMode = services.tools.subscribePenMode(onPenMode)
  services.penModeChanged?.(touch.penMode)
  const stopPenContacts = services.tools.subscribePenContacts((id, down, direct, time) => {
    try { if (down) touch.penDown(id, direct); else touch.penUp(id) }
    catch (error) { try { services.error(error) } catch { /* Other views must still receive the contact. */ } }
  })
  const stopPenMode = services.bindPenMode?.(() => touch.exitPenMode())
  let pointerClient: Point | null = null
  const unbindPointer = services.tools.bindPresentedPointer(view.token, () => {
    if (!current()) return null
    const virtual = cursor.active ? cursor.currentSample() : null
    if (virtual) return { x: virtual.x, y: virtual.y }
    if (!pointerClient) return null
    const mapping = view.mappings.latest()
    return mapping ? mapping.clientToWorld(pointerClient.x, pointerClient.y) : null
  })
  const rememberPointer = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) pointerClient = { x: event.clientX, y: event.clientY }
  }
  const forgetPointer = () => { pointerClient = null; overview.track(null) }
  const doubleTap = new TouchDoubleTap({ doc: session.doc, camera: view.camera,
    eligible: () => current() && !touch.penMode && !services.editing() && !services.modalOpen() && services.tools.getSnapshot().active.id === 'hand',
    changed: services.cameraChanged })
  const contact = (event: PointerEvent): ContactPoint => ({ ...view.mappings.surface(event.timeStamp, event.clientX, event.clientY),
    id: event.pointerId, time: event.timeStamp, width: event.width, height: event.height })
  const down = (event: PointerEvent) => {
    rememberPointer(event)
    services.textInput?.cancelPending()
    if (!current()) return
    services.cancelMotion?.()
    if (!router.activeOwner) { dismissKeyboardCursor(); cancelContinuations(); services.cancelPendingGestures() }
    let focusSurface = event.pointerType !== 'touch'
    if (event.pointerType === 'pen') { doubleTap.clear(); services.tools.penDown(owner, event.pointerId, services.isDirectPen(event), event.timeStamp) }
    else if (event.pointerType === 'touch') {
      const point = contact(event), admitted = touch.touchDown(point); touchAdmission.set(event.pointerId, admitted); focusSurface = admitted
      const target = event.target
      const control = target instanceof Element && !!target.closest('button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="dialog"], [role="listbox"]')
      doubleTap.down(event.pointerId, point, event.timeStamp, admitted && !control)
      try { view.surface.setPointerCapture(event.pointerId) }
      catch { doubleTap.up(event.pointerId, point, event.timeStamp, true); touch.touchUp(event.pointerId); touchAdmission.delete(event.pointerId); return }
    }
    const target = event.target
    if (focusSurface && !services.editing() && target instanceof Element && view.surface.contains(target)
      && !target.closest('button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="dialog"], [role="listbox"]')) {
      view.surface.focus({ preventScroll: true })
    }
  }
  const move = (event: PointerEvent) => {
    rememberPointer(event)
    if (event.pointerType !== 'touch' && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) overview.track(view.clientToSurface(event.clientX, event.clientY))
    services.textInput?.cancelPending()
    if (!current()) return
    if (event.pointerType === 'touch') { const point = contact(event); doubleTap.move(event.pointerId, point); touch.touchMove(point) }
    else if (event.pointerType === 'pen' && event.buttons === 0) touch.penHover()
  }
  const up = (event: PointerEvent) => {
    if (event.pointerType === 'pen') services.tools.penUp(owner, event.pointerId, event.timeStamp)
    else if (event.pointerType === 'touch') {
      doubleTap.up(event.pointerId, contact(event), event.timeStamp, event.type !== 'pointerup')
      touch.touchUp(event.pointerId); touchAdmission.delete(event.pointerId)
    }
  }
  // Deferred text hits must also stop before non-tool keys, touch navigation and wheel changes.
  const keyActivity = (event: KeyboardEvent) => {
    const cancelled = services.textInput?.cancelPending()
    if (cancelled && event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
  }
  const wheelActivity = () => { services.textInput?.cancelPending(); services.cancelMotion?.() }
  const auxclick = (event: MouseEvent) => { if (event.button === 1 || event.button === 2) event.preventDefault() }
  const doubleClick = (event: MouseEvent) => {
    if (!current() || !editable() || event.button !== 0) return
    let handled = false
    try {
      if (services.handleDoubleClick) handled = services.handleDoubleClick(
        view.mappings.surface(event.timeStamp, event.clientX, event.clientY), view.mappings.map(event.timeStamp, event.clientX, event.clientY), event.timeStamp)
      if (!handled) handled = services.textInput?.doubleClick(event.clientX, event.clientY) ?? false
    } catch (error) { services.error(error) }
    if (handled) { event.preventDefault(); event.stopPropagation() }
  }
  const dragover = (event: DragEvent) => { event.preventDefault(); event.stopPropagation() }
  const drop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); if (current() && editable()) services.drop?.(event) }
  view.surface.addEventListener('keydown', keyActivity, true)
  view.surface.addEventListener('wheel', wheelActivity, { capture: true, passive: true })
  view.surface.addEventListener('dragover', dragover)
  view.surface.addEventListener('drop', drop)
  view.surface.addEventListener('auxclick', auxclick)
  view.surface.addEventListener('dblclick', doubleClick)
  view.surface.addEventListener('pointerdown', down, true)
  view.surface.addEventListener('pointermove', move, true)
  view.surface.addEventListener('pointerleave', forgetPointer, true)
  view.surface.addEventListener('pointerup', up, true)
  view.surface.addEventListener('pointercancel', up, true)
  view.surface.addEventListener('lostpointercapture', up, true)
  const stopWet = view.wet.attach(handover)
  const stopFrame = view.wet.onInputFrame(() => {
    if (current()) {
      try { if (pointer.publishPendingInk()) view.wet.invalidate() }
      catch (error) { pointer.interrupt('os-cancel'); services.error(error) }
    }
    if (current() && router.activeOwner instanceof LiveInk) {
      const owner = router.activeOwner
      // A delegated stroke republishes even when clean, so its newest sample gets a curve to present.
      owner.publish(!!delegated?.wantsExclusive(owner.delegatedState))
      delegated?.submittedCurve(owner.delegatedCandidate)
    } else if (current() && router.activeOwner instanceof InkContinuationGesture) {
      const owner = router.activeOwner
      try { owner.publish() }
      catch (error) {
        if (owner.pointerIds.has(-1)) cancelKeyboardGesture(); else pointer.interrupt('os-cancel')
        services.error(error)
      }
    }
  })
  const stopWheel = installWheel(view.surface, {
    camera: view.camera, paged: view.paged, toSurface: view.clientToSurface, invertZoom: () => services.invertMouseZoom?.() ?? false,
    owns: event => current() && services.ownsWheel(event),
    changed: () => {
      cancelForCamera()
      services.cameraChanged()
    },
  })
  let keyboardStart: ToolStateSnapshot | null = null
  const cursor = createKeyboardCursor({
    token: view.token, current: () => current(),
    toWorld: point => surfaceToWorld(point, view.camera.camera),
    ensureVisible(point) {
      if (services.keyboardCursorVisible) return services.keyboardCursorVisible(point)
      const viewport = view.camera.viewport
      const x = Math.max(0, Math.min(viewport.width, point.x)), y = Math.max(0, Math.min(viewport.height, point.y))
      if (point.x !== x || point.y !== y) { view.camera.panBy({ x: point.x - x, y: point.y - y }); services.cameraChanged() }
      return { x, y }
    },
    show: (point, active) => view.a11y.keyboardCursor?.(point, active),
    begin(sample, modifiers) {
      if (!current() || !editable() || !claim()) return false
      keyboardStart = services.tools.getSnapshot()
      try {
        const choice = keyboardStart.active
        const continued = choice.id === 'pen' && modifiers.shift ? services.continueInk?.(sample) : null
        const route = continued ? { tool: continuationTool(sample, continued), context: undefined }
          : choice.id === 'pen' || choice.id === 'highlighter'
            ? { tool: ink(choice.id), context: undefined }
            : services.resolveKeyboardTool?.(choice, sample, modifiers)
        if (!route || !router.begin(view.token, route.tool, sample, modifiers, route.context)) { keyboardStart = null; releaseClaim(); return false }
        return true
      } catch (error) { keyboardStart = null; releaseClaim(); services.error(error); return false }
    },
    update: (sample, modifiers) => router.update(view.token, sample.pointerId, [sample], modifiers),
    finish() {
      try { router.finish(view.token, -1, 'up'); if (keyboardStart && editable()) services.tools.complete(keyboardStart) }
      finally { keyboardStart = null; releaseClaim() }
    },
    escape() { try { router.interrupt(view.token, 'escape') } finally { keyboardStart = null; releaseClaim() } },
    undo() { try { router.interrupt(view.token, 'undo') } finally { keyboardStart = null; releaseClaim() } },
  })
  cancelKeyboardGesture = () => cursor.active && cursor.escape()
  dismissKeyboardCursor = () => { if (cursor.active) cursor.escape() }
  const flush = () => {
    cancelContinuations()
    services.cancelPendingGestures()
    cursor.escape()
    pointer.interrupt('flush')
    services.textInput?.flush()
  }
  const stopFlush = view.bindFlush?.(flush)
  const pagehide = () => { if (current()) flush() }
  window.addEventListener('pagehide', pagehide)
  const stopCursor = view.a11y.bindKeyboardCursor?.(() => {
    if (!current()) return
    const viewport = view.camera.viewport
    cursor.activate(services.keyboardCursorInitial?.() ?? { x: viewport.width / 2, y: viewport.height / 2 })
    view.surface.focus()
  })
  const stopKeys = installKeyboard(view.surface, {
    visible: current, enabled: editable, shortcutsEnabled: services.shortcutsEnabled,
    modalOpen: services.modalOpen, editing: services.editing,
    cursor, navigation: services.keyboardNavigation ? () => services.keyboardNavigation!(cursor.active) : undefined, gestureActive: () => router.activeOwner !== null,
    typeText: text => !!services.textInput?.type(text),
    modifierChanged: modifiers => { trackShift(modifiers.shift); pointer.modifiersChanged(modifiers) },
    clearLatches: () => { services.textInput?.cancelPending(); cancelContinuations(); services.cancelPendingGestures(); spaceHeld = false; zoomHeld = false; shiftHeld = false; overview.leave(); cursor.escape(); pointer.interrupt('flush'); services.clearLatches?.() },
    run(id, event) {
      if (!current()) return false
      if (id === 'accessibility.repeat' && view.a11y.repeatAnnouncement?.()) return true
      if (id === 'accessibility.contextMenu' && services.keyboardContextMenu) {
        const sample = cursor.active ? cursor.currentSample() : null
        const viewport = view.camera.viewport
        const surface = sample ? view.sampleToSurface(sample) : services.keyboardCursorInitial?.() ?? { x: viewport.width / 2, y: viewport.height / 2 }
        if (![surface.x, surface.y, viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return false
        const point = { x: Math.max(0, Math.min(viewport.width, surface.x)), y: Math.max(0, Math.min(viewport.height, surface.y)) }
        return services.keyboardContextMenu(point, surfaceToWorld(point, view.camera.camera))
      }
      if (id === 'escape') {
        if (overview.active) { overview.escape(); zoomHeld = false; return true }
        const continuationCancelled = cancelContinuations(), cancelled = services.cancelPendingGestures()
        if (pointer.interrupt('escape') || cancelled || continuationCancelled) return true
      }
      if (id === 'undo') {
        const continuationCancelled = cancelContinuations(), cancelled = services.cancelPendingGestures()
        if (pointer.interrupt('undo') || cancelled || continuationCancelled) return true
        if (editable()) { services.history.undo(); return true }
      }
      if (id === 'redo' && editable()) {
        const continuationCancelled = cancelContinuations(), cancelled = services.cancelPendingGestures()
        if (cursor.active && router.activeOwner) { cursor.escape(); return true }
        if (pointer.interrupt('flush') || cancelled || continuationCancelled) return true
        services.history.redo(); return true
      }
      if (id === 'delete' && editable()) {
        const continuationCancelled = cancelContinuations(), cancelled = services.cancelPendingGestures()
        if (router.activeOwner) {
          if (cursor.active && router.activeOwner.pointerIds.has(-1)) cursor.escape(); else pointer.interrupt('os-cancel')
          return true
        }
        if (cancelled || continuationCancelled) return true
        const sample = cursor.currentSample()
        if (sample && services.keyboardHandleCommand?.(id, sample)) return true
      }
      if (id === 'edit.start' && editable() && services.textInput?.enter()) return true
      if (id.startsWith('style.')) flush()
      if (id === 'tool.lock' && editable()) { services.tools.toggleLocked(); return true }
      if (id === 'pan.hold') {
        spaceHeld = true
        if (!(router.activeOwner instanceof LiveInk)) return true
        let previous: Point
        return router.suspendInk(view.token, {
          begin: sample => { previous = physicalSurface(sample) },
          update: samples => { for (const sample of samples) { const point = physicalSurface(sample); view.camera.panBy({ x: previous.x - point.x, y: previous.y - point.y }); previous = point }; services.cameraChanged() },
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
      if (id === 'zoom.release') { overview.leave(); zoomHeld = false; return true }
      if (id.startsWith('tool.bar.') && editable()) {
        // The chrome publishes the tools its bar shows; a slot the bar does not show (narrow pane, or a figure that is
        // unavailable) does nothing, so the key falls through to the other bindings as an unbound key would.
        const digit = Number(id.slice('tool.bar.'.length)), choice = services.tools.barTool(digit === 0 ? 9 : digit - 1)
        if (!choice) return false
        if (choice.id === 'media') return services.commands.run('media.insert', event)
        cancelContinuations(); services.cancelPendingGestures()
        services.tools.setTool(choice.id, choice.variant); return true
      }
      if (id.startsWith('tool.') && editable()) {
        cancelContinuations(); services.cancelPendingGestures()
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
      services.textInput?.cancelPending()
      cancelContinuations(); services.cancelPendingGestures()
      if (cursor.active) cursor.escape()
      pointer.interrupt('flush')
    }
    if (current() && editable() && !services.tools.syncingDocument) {
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
  const stopSession = session.subscribe(() => {
    if (!current() || !editable()) return
    const snapshot = services.tools.getSnapshot()
    services.tools.withDocumentSync(() => {
      if (snapshot.locked !== session.doc.view.toolLock) {
        services.tools.setLocked(session.doc.view.toolLock)
        services.persistToolLock?.(session.doc.view.toolLock)
      }
      const tool = session.doc.ui.tool
      services.tools.adoptTool(tool)
    })
  })
  updateMirror()
  const detach = () => {
    if (!live) return
    flush()
    window.removeEventListener('pagehide', pagehide)
    stopFlush?.(); delegated?.dispose(); unbindPointer(); doubleTap.dispose(); edgeScroll.dispose(); cursor.dispose(); stopCursor?.()
    pointer.dispose()
    live = false
    view.surface.removeEventListener('keydown', keyActivity, true)
    view.surface.removeEventListener('wheel', wheelActivity, true)
    view.surface.removeEventListener('dragover', dragover)
    view.surface.removeEventListener('drop', drop)
    view.surface.removeEventListener('auxclick', auxclick)
    view.surface.removeEventListener('dblclick', doubleClick)
    view.surface.removeEventListener('pointerdown', down, true)
    view.surface.removeEventListener('pointermove', move, true)
    view.surface.removeEventListener('pointerleave', forgetPointer, true)
    view.surface.removeEventListener('pointerup', up, true)
    view.surface.removeEventListener('pointercancel', up, true)
    view.surface.removeEventListener('lostpointercapture', up, true)
    services.tools.releasePenOwner(owner, performance.now()); stopPenContacts(); stopSharedPenMode()
    stopPenMode?.(); stopKeys(); stopWheel(); stopFrame(); stopSession(); stopMirror()
    try { stopWet() } finally { handover.dispose() }
    if (attached.get(view.surface) === detach) attached.delete(view.surface)
    services.tools.releaseInput(owner)
  }
  attached.set(view.surface, detach)
  return detach
}
