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
import { ChromeToolDrag } from './chromeDrag'
import { EdgeScroll } from './edgeScroll'
import { TouchDoubleTap } from './touchDoubleTap'
import { DelegatedInkBridge, type PresentedWetSample } from './delegatedBridge'
import { InputRouter } from './router'
import { sessionInkTool, type SessionInkServices } from './sessionInk'
import { zoomBrushTool, type ZoomBrushContext } from './zoomBrush'
import { QuickOverview } from './quickOverview'
import { ModifierRelease } from './modifierRelease'
import { oneFingerZoomTool, type OneFingerZoomContext } from './oneFingerZoom'
import { stepBoardZoom } from './cameraZoom'
import { CLICK_SLOP_CSS, sampleSurface, type GestureOwner, type InputToken, type Modifiers, type RealSample, type Tool } from './tool'
import type { KeyboardNavigationPriority } from './scrollKeysTypes'
import type { TextInputBridge } from '../text/edit/managerTypes'
import { isCancellation } from '../../platform/workers/envelope'

export type BoardInputMode = 'edit' | 'view'
/** A touch within this many px of a window side is the OS's navigation gesture, not the board's (catalogue I§4.1). */
const TOUCH_EDGE_GUARD_PX = 10
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
  /** The route a bar tool takes when it is dragged onto the board; null when the tool has no toolbar drag. */
  resolveChromeDrag?(choice: ToolStateSnapshot['active'], sample: RealSample, modifiers: Modifiers): PointerRoute<unknown> | null
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
  mouseWheel?(): boolean
  /** Animated zoom to an absolute zoom at the anchor (double-tap and the zoom tool's steps). */
  animateZoom?(zoom: number, anchor: Point): void
  /** A glide of the camera by a screen-space delta (Space+arrow pages one screen). */
  error(error: unknown): void
  pointerChanged?(sample: RealSample): void
  /** An edit made by a key (a nudge, a turn, a flip) is still landing. */
  keyEditLanding?(): boolean
  /** Settles once the pastes, drops and duplicates asked for so far have landed; null when none is on its way. */
  pasteLanding?(): Promise<void> | null
  hover?(event: PointerEvent): void
  contextMenu?(event: MouseEvent): void
  drop?(event: DragEvent): void
  linkAt?(sample: RealSample): (() => void) | null
  continueInk?(sample: RealSample): InkContinuation | null
  bindPenMode?(exit: () => void): Detach
  penModeChanged?(enabled: boolean): void
  persistToolLock?(locked: boolean): void
  clearLatches?(): void
  /** Clears a laser trail that is still on screen; true when there was one (Escape then keeps the laser selected). */
  clearLaserTrail?(): boolean
  cancelPendingGestures(): boolean
  /** Cancels the finished gestures still landing whose landing would be the next undo step (a released erase): an undo
   * takes them back. True when there were any. */
  undoSettlingGestures?(): boolean
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
  /** Set while the displaced tool is put back: that change must not cancel the erase it follows, which is still committing. */
  let restoringTool = false
  let spaceHeld = false
  let zoomHeld = false
  // F-TOOL-009: the quick overview is Shift pressed while Z is held. Shift pressed first is the direct zoom route, not this.
  let shiftHeld = false
  const overview = new QuickOverview(() => services.zoomBrush())
  // Catalogue T§4: while Z is held the cursor is zoom-in, zoom-out while Alt is held, and the quick overview has neither (its
  // state keeps the default arrow). Z is a hold, not a tool, so no tool sets it: this owns the surface cursor for the hold and
  // puts back what was there on release.
  let cursorBeforeZoom: string | null = null, altHeld = false
  const showZoomCursor = (): void => {
    const surface = view.surface
    if (!zoomHeld) { if (cursorBeforeZoom !== null) { surface.style.cursor = cursorBeforeZoom; cursorBeforeZoom = null } return }
    if (cursorBeforeZoom === null) cursorBeforeZoom = surface.style.cursor
    surface.style.cursor = overview.active ? 'default' : altHeld ? 'zoom-out' : 'zoom-in'
  }
  const trackShift = (held: boolean) => {
    if (held === shiftHeld) return
    shiftHeld = held
    if (!zoomHeld) return
    if (held) { if (!router.activeOwner) overview.enter() } else overview.leave()
    showZoomCursor()
  }
  // Cmd/Ctrl held over Draw or Highlight erases until it is released (catalogue T§14). The eraser's own Cmd means "top-most
  // item only", so the temporary eraser takes whole items: accel is stripped from its gestures. The displaced tool returns
  // on release, after a stroke already in progress has ended.
  /** Keys pressed while released work was landing, which wait for it before they act (see `runBound`). */
  let keysWaiting = 0
  const keysIdle: (() => void)[] = []
  const keyActed = () => { if (--keysWaiting === 0) for (const resolve of keysIdle.splice(0)) resolve() }
  /** Once the keys still waiting have acted and every hold has let go: a press queued behind a key is replayed after it. A key
   * that waits for a paste is in no queue the gesture FIFO knows of, and the FIFO's empty task alone resolved at once while it
   * still waited: the router asked again, at once, for ever, and the page hung in microtasks. */
  const afterKeys = (signal: AbortSignal): Promise<void> => keysWaiting === 0 ? session.enqueueAfterGesture(signal, () => undefined)
    : new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return }
      keysIdle.push(resolve)
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
    }).then(() => afterKeys(signal))
  let accelHeld = false, accelTool: string | null = null, accelReturn = false
  const releaseAccelEraser = () => {
    const back = accelTool
    accelTool = null; accelReturn = false
    // Restoring must not cancel the erase it follows, which may still be committing (the same guard as restoreTool's).
    if (back && services.tools.getRegistration(back) && services.tools.getSnapshot().active.id === 'eraser') {
      restoringTool = true
      try { services.tools.setTool(back) } finally { restoringTool = false }
    }
  }
  const holdAccelEraser = (modifiers: Modifiers) => {
    accelHeld = modifiers.accel
    // Giving the tool back never waits on the view being editable: a release that did was lost for good.
    if (!modifiers.accel) {
      if (accelTool === null) return
      if (router.activeOwner) accelReturn = true
      else releaseAccelEraser()
      return
    }
    if (!editable() || !services.tools.getRegistration('eraser')) return
    const active = services.tools.getSnapshot().active.id
    if (accelTool === null && !router.activeOwner && (active === 'pen' || active === 'highlighter')) { accelTool = active; services.tools.setTool('eraser') }
  }
  const modifierRelease = new ModifierRelease(modifiers => { trackShift(modifiers.shift); altHeld = modifiers.alt; showZoomCursor(); holdAccelEraser(modifiers); pointer.modifiersChanged(modifiers) })
  const wholeItems = (owner: GestureOwner): GestureOwner => ({
    kind: owner.kind, pointerIds: owner.pointerIds,
    update: (samples, modifiers) => owner.update(samples, { ...modifiers, accel: false }),
    suspend: owner.suspend ? () => owner.suspend!() : undefined,
    discard: owner.discard ? () => owner.discard!() : undefined,
    finish: reason => owner.finish(reason), cancel: reason => owner.cancel(reason),
  })
  const wholeItemsRoute = <C,>(route: PointerRoute<C> | null): PointerRoute<C> | null => route && { ...route, tool: {
    id: route.tool.id, holdsNoGesture: route.tool.holdsNoGesture,
    begin: (sample, modifiers, context) => { const owner = route.tool.begin(sample, { ...modifiers, accel: false }, context); return owner && wholeItems(owner) },
  } }
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
  // Every hand pan flings on release, mouse included: the wheel's middle button and the Hand tool slide the same way a touch does.
  const handContext: HandContext = {
    toSurface: physicalSurface,
    panBy: delta => view.camera.panBy(delta),
    invalidate: services.cameraChanged,
    startFling: services.startFling,
    flingEnabled: true,
  }
  // One zoom step in, animated when the host can. A double tap's release and the zoom tool's click share this rule.
  const zoomInOneStep = (point: Point) => {
    const target = stepBoardZoom(session.doc, view.camera, 1)
    if (services.animateZoom) services.animateZoom(target, point)
    else view.camera.zoomTo(target, point)
    services.cameraChanged()
  }
  const oneFingerContext: OneFingerZoomContext = {
    toSurface: physicalSurface,
    zoomNow: () => view.camera.camera.z,
    zoomTo: (zoom, anchor) => { view.camera.zoomTo(zoom, anchor); services.cameraChanged() },
    zoomIn: zoomInOneStep,
    clamp: zoom => view.camera.clampZoom(zoom),
  }
  const fingerZoom: Tool<unknown> = oneFingerZoomTool(oneFingerContext)
  const hand: Tool<unknown> = { id: handTool.id, begin: (sample, modifiers) => handTool.begin(sample, modifiers, handContext) }
  // Right-button drag pans and never opens a menu on release; a stationary press opens the board menu on release (F-INPUT-012).
  const secondaryPan: Tool<PointerEvent | undefined> = {
    id: 'secondary-pan', holdsNoGesture: true,
    begin(sample, modifiers, press) {
      const origin = physicalSurface(sample)
      // A pen's tip wanders a few px during a barrel tap, more than a mouse's right click, and a tap taken for a drag opens no menu.
      const slop = sample.source === 'pen' ? CLICK_SLOP_CSS : 4
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
            if (!dragging && Math.hypot(surface.x - origin.x, surface.y - origin.y) >= slop) dragging = true
            if (dragging) pan.update([point], nextModifiers)
          }
        },
        finish(reason) {
          pan.finish(reason); release()
          // A static right-click acts on the selection, so a non-Select tool gives way to Select first (catalogue I§2.3).
          if (reason === 'up' && !dragging && press) {
            if (editable() && services.tools.getSnapshot().active.id !== 'select') services.tools.setTool('select')
            services.contextMenu?.(press)
          }
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
  // Only a gesture still in someone's hands refuses a press. Work already released (an erase or a box landing, a commit
  // awaiting its frame) holds the session too, and refused every press made in that window (measured: 3 of 6 presses
  // dropped at a 30 ms gap on a 158-stroke board, 1 at 60 ms).
  const claim = (): boolean => services.tools.claimInput(owner, session.isInputGestureActive)
  const releaseClaim = (): void => { services.tools.releaseInput(owner) }
  const delegated = session.doc.kind === 'whiteboard' && view.wet.onRealPresented ? new DelegatedInkBridge({
    surface: view.surface, mappings: view.mappings, camera: () => view.camera.camera, current,
    onRealPresented: callback => view.wet.onRealPresented!(callback),
  }) : null
  const edgeScroll = new EdgeScroll({ surface: view.surface, camera: view.camera, mappings: view.mappings, router, token: view.token,
    mac: services.mac, current, enabled: () => services.edgeScrolling?.() ?? true, cameraChanged: services.cameraChanged,
    onInputFrame: callback => view.wet.onInputFrame(callback), invalidate: () => view.wet.invalidate() })
  const pointer = new PointerRouter<unknown, ToolStateSnapshot>({
    root: view.surface, mappings: view.mappings, token: view.token, router, mac: services.mac, current,
    sampleChanged: sample => { edgeScroll.sample(sample); services.pointerChanged?.(sample) },
    realEvent: (sample, event) => delegated?.observe(event, sample),
    penTransitions: () => { const id = services.tools.getSnapshot().active.id; return id === 'pen' || id === 'highlighter' },
    settled: afterKeys,
    landing: () => services.keyEditLanding?.() === true || keysWaiting > 0,
    cancelPending: services.cancelPendingGestures,
    hover: services.hover,
    claim, releaseClaim,
    // A press kept behind a key that is still waiting is resolved once that key has acted: the key came first.
    pressed: () => keysWaiting > 0 ? undefined : services.tools.getSnapshot(),
    resolve(sample, modifiers, event, pressed) {
      if (!current() || (sample.source === 'touch' && !touchAdmission.get(sample.pointerId))) return null
      // Pen mode keeps a palm or a finger from drawing: a touch pressed on the canvas is rejected before any state changes
      // (catalogue I§5.2). A mouse is never a palm, and it was rejected too: pen mode starts at a pen's first press on any machine
      // with a touchscreen (isDirectPen reads only that), so a laptop's touchscreen beside a drawing tablet left the mouse unable
      // to select, drag or draw on the board after the first pen stroke.
      if (touch.penMode && sample.source === 'touch') return null
      // A press queued behind a contact still landing is resolved after it, with the tool chosen when it was pressed: a tool picked
      // from the bar meanwhile would otherwise turn a stroke into whatever that tool does.
      start = pressed ?? services.tools.getSnapshot()
      activeSource = sample.source
      const choice = start.active
      completeTool = false
      if (sample.source === 'pen' && ((event.type === 'pointerdown' && event.button === 5) || (sample.buttons & 32) !== 0)) {
        if (!editable()) return null
        // Eraser-end selects Eraser for as long as it is held, separately from the E key and the right button. Only a press
        // does: inside a contact (the pen's eraser bit turning on mid-stroke, routed here by penTransitions) a tool choice is a
        // tool change, which flushes the pointer. That ended the contact while it was starting this eraser, so the eraser began
        // with nothing left to finish it, its gesture hold refused every later press until a reload, and the displaced Eraser
        // was saved as the person's tool (measured: ink → eraser bit → ink in one pen contact; every later press "claim
        // refused", router owner 'erase', Eraser left chosen). The tool chosen stays, so the ink after it resolves to ink again.
        if (event.type === 'pointerdown' && start.active.id !== 'eraser' && services.tools.getRegistration('eraser')) {
          restoreTool = start.active.id; services.tools.setTool('eraser')
        }
        return services.resolveTool({ id: 'eraser' }, sample, modifiers, event)
      }
      if (event.type === 'pointerdown' && event.button === 1) { event.preventDefault(); return { tool: hand, context: undefined } }
      // A right press, or a pen's barrel press, pans when dragged and opens the board's menu when released as a click. A barrel
      // pressed while the pen is drawing belongs to that stroke (F-INPUT-008); it changes the contact's buttons and is no press.
      // A check here that the pen was drawing read `activeSource`, set from this very press a few lines up, so it refused every
      // barrel press: a pen with its barrel held could neither pan nor open the menu (measured: the camera stayed, no menu).
      if (event.type === 'pointerdown' && (event.button === 2 || (services.mac && event.button === 0 && event.ctrlKey))) {
        return { tool: secondaryPan, context: event }
      }
      if (event.type === 'pointerdown' && event.button !== 0) return null
      if (spaceHeld) { temporaryPan = true; return { tool: hand, context: undefined } }
      if (zoomHeld) {
        // The overview's press lands the destination and returns to Draw while Z is still held: no gesture follows.
        if (overview.active) { overview.leave(); zoomHeld = false; showZoomCursor(); return null }
        const source = services.zoomBrush()
        const context = { ...source, toSurface: (point: RealSample) => sampleSurface(point, source.toSurface) }
        return { tool: { id: zoomBrushTool.id, begin: (point, keys) => zoomBrushTool.begin(point, keys, context) }, context: undefined }
      }
      if (editable() && services.editing() && services.textInput) {
        const textRoute = services.textInput.pointer(sample, modifiers, event, sample.clicks ?? 1)
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
      if (sample.source === 'touch' && choice.id === 'hand' && doubleTap.claimHold(sample.pointerId)) return { tool: fingerZoom, context: undefined }
      if (mode === 'view' || choice.id === 'hand') return { tool: hand, context: undefined }
      if (!editable()) return null
      if ((choice.id === 'pen' || choice.id === 'highlighter') && modifiers.accel && services.tools.getRegistration('eraser')) {
        return wholeItemsRoute(services.resolveTool({ id: 'eraser' }, sample, modifiers, event))
      }
      completeTool = true
      if (choice.id === 'pen' && modifiers.shift) {
        const commit = services.continueInk?.(sample)
        if (commit) return { tool: continuationTool(sample, commit), context: undefined }
      }
      if (choice.id === 'pen' || choice.id === 'highlighter') return { tool: ink(choice.id), context: undefined }
      const routed = accelTool !== null && choice.id === 'eraser' ? wholeItemsRoute(services.resolveTool(choice, sample, modifiers, event))
        : services.resolveTool(choice, sample, modifiers, event)
      // A creation's commit is still running after up; the single-use return to Select writes ui.tool,
      // which bumps the revision and cancels pending gestures, so it would abort that commit.
      if (routed?.completesTool) completeTool = false
      return routed
    },
    ended(reason) {
      delegated?.clear()
      if (accelReturn && !accelHeld) releaseAccelEraser()
      // A non-editable view must not write the single-use reset: complete() can persist ui.tool to the shared document.
      if (reason === 'up' && start && completeTool && editable()) services.tools.complete(start)
      completeTool = false
      if (restoreTool !== null && editable() && services.tools.getRegistration(restoreTool)) {
        restoringTool = true
        try { services.tools.setTool(restoreTool) } finally { restoringTool = false }
      }
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
  // A bar tool pressed on the chrome: the board's router owns the drag once the pointer leaves the bar (see ChromeToolDrag).
  const chromeDrag = new ChromeToolDrag<unknown>({ token: view.token, router, mappings: view.mappings, mac: services.mac, current, editable,
    claim, releaseClaim,
    // In pen mode a finger dragged off the bar creates nothing (catalogue I§5.2); its tap still selects. A mouse drags as ever.
    resolve: (choice, sample, modifiers) => touch.penMode && sample.source === 'touch' ? null : services.resolveChromeDrag?.(choice, sample, modifiers) ?? null,
    select: choice => services.tools.setTool(choice.id, choice.variant), snapshot: () => services.tools.getSnapshot(),
    complete: start => services.tools.complete(start),
    focus: () => view.surface.closest<HTMLElement>('.board-interaction-root')?.focus({ preventScroll: true }), error: services.error })
  const unbindChromeDrag = services.tools.bindChromeDrag(view.token, (choice, event, bar) => chromeDrag.begin(choice, event, bar))
  let cancelKeyboardGesture = () => false
  let dismissKeyboardCursor = () => {}
  // An erase is not among them: its path is in world units and each stretch is asked through the view of that moment, so
  // a view that moves under it (a palm's pan in pen mode, a wheel turn) changes nothing it erases. Cancelled here, a palm
  // resting beside the pen ended the erase in the middle of the drag and every item it had touched came back.
  const cancelForCamera = () => {
    cancelContinuations(); services.cancelPendingGestures()
    const active = router.activeOwner
    if (!active || !['node-edit', 'marquee', 'zoom-brush'].includes(active.kind)) return
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
  // The latest primary press, and whether it travelled past a click: the browser fires `dblclick` on the release of ANY
  // second press inside the double-click time, dragged or not, and only one that stayed a click is a double-click (below).
  let press: { readonly id: number; readonly x: number; readonly y: number; dragged: boolean } | null = null
  const trackPress = (event: PointerEvent) => {
    if (event.type === 'pointerdown') { if (event.button === 0) press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false }; return }
    if (press && !press.dragged && press.id === event.pointerId && event.buttons
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= CLICK_SLOP_CSS) press.dragged = true
  }
  const doubleTap = new TouchDoubleTap({
    eligible: () => current() && !touch.penMode && !services.editing() && !services.modalOpen() && services.tools.getSnapshot().active.id === 'hand',
    zoomIn: zoomInOneStep, changed: services.cameraChanged })
  const contact = (event: PointerEvent): ContactPoint => ({ ...view.mappings.surface(event.timeStamp, event.clientX, event.clientY),
    id: event.pointerId, time: event.timeStamp, width: event.width, height: event.height })
  const modifiersOf = (event: KeyboardEvent | MouseEvent): Modifiers => ({ shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, accel: services.mac ? event.metaKey : event.ctrlKey })
  // What is held is read off every pointer event too, never only off a keydown/keyup pair the board may half see: a
  // key-up that went to another element or window left the temporary tool up until the key was pressed and released
  // again on the board (measured: ⌘'s key-up kept from the board, Draw stayed the Eraser through hovers and presses).
  const reconcileModifiers = (event: PointerEvent) => { if (current()) modifierRelease.update(modifiersOf(event)) }
  const down = (event: PointerEvent) => {
    rememberPointer(event)
    trackPress(event)
    services.textInput?.cancelPending()
    if (!current()) return
    services.cancelMotion?.()
    // A key released a moment ago must not count as held at the start of this press (catalogue I§1.4); nor one the board
    // saw go down but never come up, which this press's own flags say is not held.
    reconcileModifiers(event)
    modifierRelease.flush()
    if (!router.activeOwner) { dismissKeyboardCursor(); cancelContinuations(); services.cancelPendingGestures() }
    let focusSurface = event.pointerType !== 'touch'
    if (event.pointerType === 'pen') { doubleTap.clear(); services.tools.penDown(owner, event.pointerId, services.isDirectPen(event), event.timeStamp) }
    else if (event.pointerType === 'touch') {
      // A touch, like any press, waits for a presented frame of this showing (pointer.ts `down`): mapped through none, it threw
      // "No presented input mapping" out of this listener on a touch the moment a board was shown.
      if (!view.mappings.ready()) return
      const point = contact(event)
      // A touch at a window's edge belongs to the OS (back and forward swipes) and is never admitted (catalogue I§4.1).
      const edge = event.clientX < TOUCH_EDGE_GUARD_PX || event.clientX > window.innerWidth - TOUCH_EDGE_GUARD_PX
      const admitted = !edge && touch.touchDown(point); touchAdmission.set(event.pointerId, admitted); focusSurface = admitted
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
    trackPress(event)
    if (event.pointerType !== 'touch' && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) overview.track(view.clientToSurface(event.clientX, event.clientY))
    services.textInput?.cancelPending()
    if (!current()) return
    // A hover is enough: the tool shown on the bar follows the keys really held before any press.
    reconcileModifiers(event)
    if (event.pointerType === 'touch' && view.mappings.latest()) { const point = contact(event); doubleTap.move(event.pointerId, point); touch.touchMove(point) }
    else if (event.pointerType === 'pen' && event.buttons === 0) touch.penHover()
  }
  const up = (event: PointerEvent) => {
    if (event.pointerType === 'pen') services.tools.penUp(owner, event.pointerId, event.timeStamp)
    else if (event.pointerType === 'touch') {
      if (view.mappings.latest()) doubleTap.up(event.pointerId, contact(event), event.timeStamp, event.type !== 'pointerup')
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
    // A double-click with Shift, accel or Ctrl is no gesture at all (catalogue S§12): it creates no text and edits nothing.
    if (!current() || !editable() || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || !view.mappings.ready()) return
    let handled = false
    try {
      if (services.handleDoubleClick) handled = services.handleDoubleClick(
        view.mappings.surface(event.timeStamp, event.clientX, event.clientY), view.mappings.map(event.timeStamp, event.clientX, event.clientY), event.timeStamp)
      if (!handled) handled = services.textInput?.doubleClick(event.clientX, event.clientY) ?? false
    } catch (error) { services.error(error) }
    if (handled) { event.preventDefault(); event.stopPropagation() }
  }
  // A second press that was dragged is that drag (a box, a stroke, a move), not a double-click, so no double-click listener
  // of the board hears it (the picture crop's is on this surface too: captured here, it runs after this). Taken as one, a box
  // made as a trackpad's tap-then-drag (Tap to click), or begun where a click had just landed, selected what it covered while
  // dragged and then, released over empty paper, started a new text there, which took the selection (measured on a drawing
  // and on a PDF in Annotate: 4 strokes selected while dragging, 1 after, the new text in edit). With Draw, a tap and then a
  // stroke from the same spot left a text and no stroke.
  const draggedDoubleClick = (event: MouseEvent) => {
    if (press && (press.dragged || Math.hypot(event.clientX - press.x, event.clientY - press.y) >= CLICK_SLOP_CSS)) event.stopImmediatePropagation()
  }
  const dragover = (event: DragEvent) => { event.preventDefault(); event.stopPropagation() }
  const drop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); if (current() && editable()) services.drop?.(event) }
  view.surface.addEventListener('keydown', keyActivity, true)
  view.surface.addEventListener('wheel', wheelActivity, { capture: true, passive: true })
  view.surface.addEventListener('dragover', dragover)
  view.surface.addEventListener('drop', drop)
  view.surface.addEventListener('auxclick', auxclick)
  view.surface.addEventListener('dblclick', draggedDoubleClick, true)
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
    camera: view.camera, paged: view.paged, toSurface: view.clientToSurface, invertZoom: () => services.invertMouseZoom?.() ?? false, mouseWheel: () => services.mouseWheel?.() ?? false,
    owns: event => current() && services.ownsWheel(event),
    changed: () => {
      cancelForCamera()
      services.cameraChanged()
    },
  })
  let keyboardStart: ToolStateSnapshot | null = null
  // A creation's commit returns the tool itself after it lands (completesTool), so the keyboard finish must not complete it early.
  let keyboardCompletes = false
  let commaHeld = false
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
        keyboardCompletes = route.completesTool === true
        return true
      } catch (error) { keyboardStart = null; releaseClaim(); services.error(error); return false }
    },
    update: (sample, modifiers) => router.update(view.token, sample.pointerId, [sample], modifiers),
    finish() {
      try { router.finish(view.token, -1, 'up'); if (keyboardStart && editable() && !keyboardCompletes) services.tools.complete(keyboardStart) }
      finally { keyboardStart = null; keyboardCompletes = false; releaseClaim() }
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
    cursor, navigation: services.keyboardNavigation ? navigationNow : undefined, gestureActive: () => router.activeOwner !== null || zoomHeld,
    typeText: text => !!services.textInput?.type(text),
    modifierChanged: modifiers => modifierRelease.update(modifiers),
    // Focus leaving the board ends what is held, not what the person already did: with no gesture in the router, a change
    // still landing (a key's nudge, delete, style or turn of many items under a hold; a paste or a duplicate) is left to
    // land. Cancelled, a nudge of 220 PDF annotations followed by a click on the vault switcher was dropped and the switch
    // found nothing to save (aborted 57 ms after the key), and a paste followed by a click on Reload was lost.
    clearLatches: () => { services.textInput?.cancelPending(); cancelContinuations(); if (router.activeOwner || !session.isEditLanding) services.cancelPendingGestures(); spaceHeld = false; zoomHeld = false; shiftHeld = false; overview.leave(); showZoomCursor(); cursor.escape(); pointer.interrupt('flush'); modifierRelease.releaseAll(); services.clearLatches?.() },
    run: runBound,
  }, services.mac)
  function runBound(id: string, event: KeyboardEvent): boolean {
      if (!current()) return false
      // A key pressed after ⌘V acts after the paste has landed, as if it had been instant: an undo takes the paste back, not the
      // step before it, and Delete or Escape act on what the paste selected. The paste itself waits for no key or press.
      const pasting = !router.activeOwner && !holdsMode(id) ? services.pasteLanding?.() ?? null : null
      if (pasting) {
        keysWaiting++
        void pasting.then(() => { keyActed(); if (current()) runBound(id, event) })
          .catch(error => { if (!isCancellation(error)) services.error(error) })
        return true
      }
      if (!router.activeOwner && session.isGestureActive && !session.isInputGestureActive) {
        // Undo takes back a released erase that has not landed yet: that IS undoing it.
        if (id === 'undo' && editable() && services.undoSettlingGestures?.()) return true
        // Anything else waits for the finished work to land, then acts on its result: Delete right after a box deletes
        // what the box selected. Each branch below used to cancel that work first (and swallow the key because something
        // was cancelled), so a box then Delete deleted nothing and an erase then a tool key brought the strokes back.
        if (!holdsMode(id)) {
          // While the key waits, a press is kept behind it (`landing` above) and replayed once it has acted. Taken at once,
          // the press used the tool the key was leaving: D pressed right after a sweep and a stroke begun before the erase had
          // landed was an eraser sweep, which drew nothing and erased what the stroke crossed (measured on a 10,000-stroke
          // board: 130 more strokes gone and no stroke, for a press under 60 ms after the key; seconds on a denser one).
          let waiting = true
          const acted = () => { if (waiting) { waiting = false; keyActed() } }
          keysWaiting++
          void session.enqueueAfterGesture(new AbortController().signal, () => { acted(); if (current()) runKey(id, event) })
            .catch(error => { acted(); if (!isCancellation(error)) services.error(error) })
          return true
        }
      }
      return runKey(id, event)
  }
  // An arrow key pressed while released work is still landing waits for it, like every other key, and only then decides
  // between nudging the selection and panning: read at the press, the box's selection had not landed yet, so the key panned
  // the view instead, or the nudge found the selection changed under it and did nothing.
  function navigationNow(): KeyboardNavigationPriority {
    const now = services.keyboardNavigation!(cursor.active)
    if (router.activeOwner || !session.isGestureActive || session.isInputGestureActive) return now
    const later = (direction: string, coarse: boolean): boolean => {
      void session.enqueueAfterGesture(new AbortController().signal, () => {
        if (!current()) return
        const then = services.keyboardNavigation!(cursor.active)
        if (then.hasSelection && editable()) then.nudge(direction, coarse); else then.pan(direction, coarse)
      }).catch(error => { if (!isCancellation(error)) services.error(error) })
      return true
    }
    return { ...now, hasSelection: true, nudge: later, pan: later }
  }
  // Space and Z hold a quasi-mode, and accessibility keys speak: they act at once, never behind settling work.
  function holdsMode(id: string): boolean {
    return id === 'pan.hold' || id === 'pan.release' || id === 'zoom.hold' || id === 'zoom.release' || id.startsWith('accessibility.')
  }
  function runKey(id: string, event: KeyboardEvent): boolean {
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
      if (overview.active) { overview.escape(); zoomHeld = false; showZoomCursor(); return true }
      // A laser trail still on screen is cleared first and the laser stays chosen; this is read before the
      // pending-gesture cancel below, which clears the trail too.
      const laserCleared = services.clearLaserTrail?.() ?? false
      const continuationCancelled = cancelContinuations(), cancelled = services.cancelPendingGestures()
      const interrupted = pointer.interrupt('escape')
      if (laserCleared || interrupted || cancelled || continuationCancelled) return true
      // With nothing to cancel, Escape returns the chosen tool to Select; a persistent tool would otherwise stay chosen.
      if (editable() && services.tools.getSnapshot().active.id !== 'select') { services.tools.escape(); return true }
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
    // Comma presses the pointer at the keyboard cursor while it is held and lifts it on release (K§10.6).
    if (id === 'pointer.hold') {
      if (cursor.gesture) return true;
      if (!cursor.active) cursor.activate(services.keyboardCursorInitial?.() ?? { x: view.camera.viewport.width / 2, y: view.camera.viewport.height / 2 });
      commaHeld = cursor.enter(modifiersOf(event));
      return commaHeld;
    }
    if (id === 'pointer.release') {
      if (!commaHeld) return false;
      commaHeld = false;
      if (cursor.gesture) cursor.enter(modifiersOf(event));
      return true;
    }
    if (id === 'zoom.hold') { zoomHeld = true; services.zoomBrush().prepareOverview?.(); showZoomCursor(); return true }
    if (id === 'zoom.release') { overview.leave(); zoomHeld = false; showZoomCursor(); return true }
    if (id.startsWith('tool.bar.') && editable()) {
      // The chrome publishes the tools its bar shows; a slot the bar does not show (narrow pane, or a figure that is
      // unavailable) does nothing, so the key falls through to the other bindings as an unbound key would.
      const choice = services.tools.barTool(Number(id.slice('tool.bar.'.length)) - 1)
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
  }
  let toolEpoch = services.tools.getSnapshot().selectionEpoch
  const updateMirror = () => {
    const snapshot = services.tools.getSnapshot()
    if (snapshot.selectionEpoch !== toolEpoch) {
      toolEpoch = snapshot.selectionEpoch
      if (!restoringTool) {
        services.textInput?.cancelPending()
        cancelContinuations(); services.cancelPendingGestures()
        // Choosing a tool with the keyboard cursor placed keeps the cursor for the new tool; only a gesture it owns ends.
        if (cursor.gesture) cursor.escape()
        pointer.interrupt('flush')
      }
    }
    if (current() && editable() && !services.tools.syncingDocument) {
      const ops: Op[] = []
      const tool = TOOLS.find(id => id === snapshot.active.id)
      // A displaced tool is not the person's choice: writing the eraser into the document would bump its revision, and the
      // erase starting from that press would find the scene not ready. Restoring the tool writes nothing either way.
      if (tool && restoreTool === null && accelTool === null && session.doc.ui.tool !== tool) ops.push({ t: 'board', key: 'ui.tool', value: tool })
      const lockChanged = session.doc.view.toolLock !== snapshot.locked
      if (lockChanged) ops.push({ t: 'board', key: 'view.toolLock', value: snapshot.locked })
      try {
        if (ops.length) session.apply({ origin: 'host', label: 'Tool state', ops }).release()
        if (lockChanged) services.persistToolLock?.(snapshot.locked)
      } catch (error) { services.error(error) }
    }
    if (current()) view.a11y.toolState(snapshot)
    // The eraser shows its reach on the pointer (viewerHost.css): chosen, held with ⌘ over Draw, or the pen's eraser end alike.
    // It had the default arrow, which says neither where the eraser is nor how far it reaches.
    if (editable() && snapshot.active.id === 'eraser') view.surface.dataset.boardCursor = 'eraser'
    else delete view.surface.dataset.boardCursor
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
    // The tool state belongs to the runtime and outlives this view; a temporary eraser this view put up must not. ⌘E out
    // of Annotate holds ⌘ on the board (eraser) and then takes the board away before ⌘ comes up: every later entry, by
    // shortcut or by click, opened on the Eraser and a stroke erased instead of drawing (measured: 3 of 3 re-entries).
    if (accelTool !== null) releaseAccelEraser()
    delete view.surface.dataset.boardCursor
    window.removeEventListener('pagehide', pagehide)
    stopFlush?.(); delegated?.dispose(); unbindPointer(); unbindChromeDrag(); doubleTap.dispose(); edgeScroll.dispose(); cursor.dispose(); stopCursor?.(); modifierRelease.dispose()
    pointer.dispose()
    live = false
    view.surface.removeEventListener('keydown', keyActivity, true)
    view.surface.removeEventListener('wheel', wheelActivity, true)
    view.surface.removeEventListener('dragover', dragover)
    view.surface.removeEventListener('drop', drop)
    view.surface.removeEventListener('auxclick', auxclick)
    view.surface.removeEventListener('dblclick', draggedDoubleClick, true)
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
