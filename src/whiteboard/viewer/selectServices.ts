import { auditTimed } from '../../platform/render/renderAudit';
import { cameraChanged, forgetCamera } from './cameraCache';
import { worldToSurface, type CameraController } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { RenderToken } from '../../platform/render/types';
import type { ViewState } from '../../platform/types';
import type { Op } from '../change/ops';
import { planDelete } from '../commands/delete';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { flipBoardLeaves } from '../commands/flipLeaves';
import { stretchBoardLeaves } from '../commands/stretchLeaves';
import type { StickyDirection } from '../commands/stickyNeighbour';
import { isLocked } from '../change/commands';
import type { BoardSnapGuide } from '../geom/runtimeSnap';
import { BOARD_GRID_STEP, boardSnapGrid } from '../geom/gridSnap';
import { createBoardTranslationPlan } from '../geom/runtimeTranslation';
import { createBoardRotationPlan } from '../geom/runtimeTransforms';
import { createBoardLeafResizePlan } from '../geom/runtimeLeafPlan';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { EraserContext } from '../input/basicTools';
import type { SweptSelectionCursor, SweepPoint, SweepQueueServices } from '../input/sweepQueue';
import type { NodeId } from '../model/ids';
import { CLICK_SLOP_CSS, sampleSurface, type GestureOwner, type InputToken, type Modifiers, type RealSample } from '../input/tool';
import { leafResizeHandleGesture, rotationHandleGesture, translationHandleGesture } from '../input/transformGestures';
import { prepareFrameDrop } from '../input/frameDrop';
import { prepareNotebookTransform, prepareNotebookTranslation } from '../input/notebookTranslation';
import { createBoardCameraCommands } from './cameraCommands';
import { createSelectionCommandDriver } from './selectionCommands';
import { createStyleShortcuts } from './styleShortcuts';
import { createBackToContent } from './backToContent';
import { createKeyboardContext, type KeyboardContextRequest } from './keyboardContext';
import type { createBoardRenderServices } from '../render/services';
import type { SelectRegion, SelectToolContext } from '../tools/select';
import { boardSelectTool, type BoardSelectGestureContext } from '../input/selectGesture';
import { enterGroupAtPoint } from '../input/groupFocus';
import type { createBoardPointQuery } from './pointQuery';
import type { createBoardRegionQuery } from './regionQuery';
import { createBoardAttachmentResolver } from './attachments';
import { createShapeHandles } from './shapeHandles';
import { createStickyHandles } from './stickyHandles';
import { createCardControls, type BoardCardActions } from './cardControls';
import { createSelectionHandles } from './selectionHandles';
import { createBoardSelectionNavigation } from './selectionNavigation';
import type { BoardPreview } from './preview';
import { isCancellation } from '../../platform/workers/envelope';

// Provenance: SelectGesture, swept selection, geometry preparation, transaction
// and shared frame contracts; independent host composition, no third-party source.
export interface BoardSelectServicesOptions {
    readonly runtime: BoardRuntime;
    readonly render: Pick<ReturnType<typeof createBoardRenderServices>, 'prepareChangeGeometry' | 'pinChangeGeometry' | 'changeGeometry'>;
    readonly camera: () => ViewState;
    readonly cameraController: CameraController;
    readonly surface: HTMLElement;
    readonly inputToken: InputToken;
    readonly cameraChanged: () => void;
    /** Convert a physical sample using the mapping that actually presented it. */
    readonly sampleToSurface: (sample: RealSample) => Vec2;
    readonly point: Pick<ReturnType<typeof createBoardPointQuery>, 'hit' | 'hitTarget' | 'hitLocked'>;
    readonly region: Pick<ReturnType<typeof createBoardRegionQuery>, 'region'>;
    readonly preview: Pick<BoardPreview, 'showOps' | 'waitUntilReady' | 'waitUntilIdle' | 'armCommit' | 'finishCommit' | 'cancelCommit' | 'clear'>;
    readonly overlay: HTMLElement;
    readonly token: RenderToken;
    current(token: RenderToken): boolean;
    /** The view's own editable gate. A read-only or non-editable view refuses document commands; navigation, camera and picking stay live. */
    canMutateView(): boolean;
    readonly inputFrames: { schedule(callback: () => void, onDrop?: () => void): () => void };
    readonly editSticky: (id: NodeId) => void | Promise<void>;
    /** The embed and link-card chips' actions; absent, the cards draw no chips. */
    readonly cards?: BoardCardActions | null;
    readonly alwaysSnap?: () => boolean;
    onError(error: unknown): void;
    onKeptLocked?(ids: readonly NodeId[]): void;
    toggleWhiteboardTheme?(): void;
    openKeyboardContextMenu?(request: KeyboardContextRequest): void;
}
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
export function createBoardSelectServices(options: BoardSelectServicesOptions) {
    const { runtime, render } = options, session = runtime.session, doc = session.doc;
    const token = Object.freeze({ ...options.token });
    const pending = new Set<() => void>(), controllers = new Set<AbortController>();
    let disposed = false, regionPreview: SelectRegion | null = null, previewIds = new Set<NodeId>();
    let svg: SVGSVGElement | null = null, shape: SVGElement | null = null, guideSvg: SVGSVGElement | null = null, scheduled: (() => void) | null = null;
    let scribbleSource: readonly Vec2[] | null = null, scribbleCount = 0;
    const scribbleCamera = new Float64Array(3).fill(Number.NaN);
    let scribbleTail: SVGPolylineElement | null = null, scribblePoints: string[] = [];
    let guides: readonly BoardSnapGuide[] = [];
    let nudgeEpoch = 0, nudgeTail: Promise<void> = Promise.resolve();
    const current = () => !disposed && options.current(token);
    const mutable = () => current() && options.canMutateView() && !session.isReadOnly;
    // A refused document command is consumed, not declined: a declined key falls through to the host's global route, which can promote a document change.
    const viewRefused = () => current() && !mutable();
    const report = (error: unknown) => { try { options.onError(error); } catch { /* Preserve the original operation failure. */ } };
    const requestFrame = () => {
        if (disposed || scheduled) return;
        // Both paths clear the flag: a request the input host drops (disable, cancel) would otherwise swallow every later one.
        const clear = () => { scheduled = null; };
        scheduled = options.inputFrames.schedule(clear, clear);
    };
    const registerPending = (cancel: () => void) => {
        if (!mutable()) throw new DOMException('Board input is no longer current', 'AbortError');
        pending.add(cancel); return () => { pending.delete(cancel); };
    };
    // A sweep's queries belong to the erase or lasso that made them, which cancels them itself. They were aborted here too,
    // so the next press killed a released erase's last query and the erase was lost (the drag looked done, nothing changed).
    const cancelPending = () => {
        nudgeEpoch++;
        navigation.cancel();
        const work = [...pending], had = work.length > 0;
        pending.clear(); for (const cancel of work) { try { cancel(); } catch (error) { report(error); } }
        return had;
    };
    // Gestures the person has finished (an erase, a box) that are still landing. A new press, Escape, a tool change or
    // another key does not cancel them (cancelPending above leaves them alone); the view's end does, and an undo cancels
    // the ones whose landing would be its undo step. `settled` lets a new gesture's first decision wait for them.
    const settling = new Map<() => void, boolean>();
    let settledWaiters: (() => void)[] = [];
    const registerSettling = (cancel: () => void, undoable: boolean) => {
        if (!mutable()) throw new DOMException('Board input is no longer current', 'AbortError');
        settling.set(cancel, undoable);
        return () => {
            if (!settling.delete(cancel) || settling.size) return;
            const waiters = settledWaiters; settledWaiters = [];
            for (const wake of waiters) wake();
        };
    };
    const settled = (): Promise<void> => settling.size ? new Promise(resolve => { settledWaiters.push(resolve); }) : Promise.resolve();
    const cancelSettling = (undo: boolean): boolean => {
        let cancelled = false;
        for (const [cancel, undoable] of [...settling]) {
            if (undo && !undoable) continue;
            cancelled = true;
            try { cancel(); } catch (error) { report(error); }
        }
        return cancelled;
    };
    const setGuides = (value: readonly BoardSnapGuide[]) => { guides = value; requestFrame(); };
    // A transform preview draws the moving shape. The committed selection box must not stay behind it, and it follows
    // a translation by the offset its ops carry (every node moves by the same amount); other transforms hide it.
    let transformPreview = false, transformOffset: Vec2 | null = null;
    const translationOf = (ops: readonly Op[]): Vec2 | null => {
        let dx = 0, dy = 0;
        for (const op of ops) {
            if (op.t !== 'set' || (op.key !== 'x' && op.key !== 'y') || typeof op.value !== 'number') return null;
            const node = runtime.session.doc.nodes.get(op.id); if (!node) return null;
            if (op.key === 'x') dx = op.value - node.x; else dy = op.value - node.y;
        }
        return ops.length ? { x: dx, y: dy } : null;
    };
    // The handles and guides are written by a presented frame (writeOverlays), so a drag whose board stops presenting froze
    // them: a move that no frame wrote since the previous move is written here, with the live camera. A frame that did
    // write them clears the flag, so a board that presents every move (canvas2d) never takes this path.
    let overlaysFramed = true;
    const followMove = () => {
        const framed = overlaysFramed; overlaysFramed = false;
        if (framed || !current()) return;
        const view = options.camera();
        selectionHandles.writeLive(view, transformPreview ? transformOffset ?? 'hidden' : null);
        shapeHandles.writeLive(view, transformOffset); stickyHandles.writeLive(view, transformOffset);
        writeGuides(view.camera);
    };
    const showTransform = (ops: readonly Op[], live = false) => { transformPreview = true; transformOffset = translationOf(ops); options.preview.showOps(ops, live); followMove(); requestFrame(); };
    const clearTransform = () => { transformPreview = false; transformOffset = null; options.preview.clear(); followMove(); requestFrame(); };
    const toSurface = (point: Vec2) => worldToSurface(point, options.camera().camera);
    const physicalSurface = (sample: RealSample) => sampleSurface(sample, options.sampleToSurface);
    const attachments = createBoardAttachmentResolver({ runtime, render: runtime.render, point: options.point, camera: options.camera, current: mutable });
    const shapeHandles = createShapeHandles({ runtime, overlay: options.overlay, view: options.camera, current: mutable, visible: mutable,
        sampleToSurface: physicalSurface, alwaysSnap: options.alwaysSnap ?? (() => false), guides: setGuides,
        invalidate: requestFrame, hold: () => session.beginGesture(), registerPending,
        show: ops => showTransform(ops), waitUntilReady: options.preview.waitUntilReady, waitUntilIdle: options.preview.waitUntilIdle,
        armCommit: options.preview.armCommit, finishCommit: options.preview.finishCommit, cancelCommit: options.preview.cancelCommit,
        clear: () => clearTransform(), resolveAttachment: (point, signal, request) => attachments.resolve(point, signal, request), error: report });
    const stickyHandles = createStickyHandles({ runtime, overlay: options.overlay, view: options.camera, current: mutable, visible: mutable,
        invalidate: requestFrame, edit: options.editSticky, error: report });
    const cardControls = createCardControls({ runtime, overlay: options.overlay, view: options.camera, current, invalidate: requestFrame,
        sampleToSurface: options.sampleToSurface, actions: options.cards ?? null, error: report });
    const selectionHandles = createSelectionHandles({ runtime, overlay: options.overlay, camera: options.camera, current: mutable, visible: mutable,
        invalidate: requestFrame, error: report });
    const navigation = createBoardSelectionNavigation({ runtime, camera: options.cameraController, surface: options.surface, token,
        inputToken: options.inputToken, current, changed: options.cameraChanged, error: report });
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!mutable()) throw new DOMException('Board input is no longer current', 'AbortError');
    };
    const doRegion = async (points: readonly Vec2[], radiusCss: number, signal: AbortSignal) => {
        check(signal); const view = options.camera(), css = points.map(point => worldToSurface(point, view.camera));
        return options.region.region({ kind: 'swept', points: css, radiusCss, localToSurface: IDENTITY }, signal);
    };
    const beginSweep = (from: SweepPoint, to: SweepPoint, topOnly: boolean, radius: number): SweptSelectionCursor => {
        const controller = new AbortController(), revision = doc.rev;
        controllers.add(controller);
        let result: readonly NodeId[] | null = null, failure: unknown, stopped = false;
        const waiters = new Set<() => void>();
        const wake = () => { for (const callback of [...waiters]) callback(); waiters.clear(); };
        void (async () => {
            const ids = await doRegion([from, to], radius, controller.signal);
            check(controller.signal);
            const selected = topOnly && ids.length ? [ids[ids.length - 1]] : ids;
            await render.prepareChangeGeometry(selected, controller.signal);
            check(controller.signal);
            if (doc.rev !== revision) throw new DOMException('Board changed during sweep', 'AbortError');
            result = selected;
        })().catch(error => { if (!stopped) failure = error; }).finally(() => { controllers.delete(controller); wake(); });
        return {
            step() {
                if (stopped) return { status: 'cancelled', ids: [] };
                if (doc.rev !== revision) return { status: 'stale', ids: [] };
                if (failure) throw failure;
                if (!result) return { status: 'pending', ids: [] };
                return { status: 'complete', ids: result };
            },
            wait(callback) {
                if (stopped || result || failure || doc.rev !== revision) { callback(); return () => {}; }
                waiters.add(callback); return () => { waiters.delete(callback); };
            },
            cancel() { if (stopped) return; stopped = true; controller.abort(); controllers.delete(controller); waiters.clear(); },
        };
    };
    const sweep = (eraser: boolean): SweepQueueServices => ({
        beginSweep: (from, to, topOnly) => beginSweep(from, to, topOnly, eraser ? 8 : 6),
        sceneRevision: () => doc.rev, now: () => performance.now(), schedule: callback => options.inputFrames.schedule(callback),
        preview(ids) {
            previewIds = new Set(ids);
            if (eraser) options.preview.showOps([...ids].map(id => ({ t: 'set', id, key: 'opacity', value: 0.5 } as const)));
            requestFrame();
        },
    });
    const select: SelectToolContext = {
        selection: runtime.selection, dragThresholdCss: CLICK_SLOP_CSS, scribble: sweep(false),
        hold: () => session.beginGesture(), registerPending, toSurface, isCurrent: mutable,
        async hit(sample, signal) {
            check(signal); const revision = doc.rev;
            const point = { x: sample.x, y: sample.y }, input = sample.source === 'keyboard' ? 'mouse' : sample.source;
            const id = await options.point.hit(point, input, signal); check(signal);
            if (doc.rev !== revision) throw new DOMException('Board changed during selection query', 'AbortError');
            return id;
        },
        async region(region, signal) {
            check(signal); const camera = options.camera().camera;
            if (region.kind === 'scribble') return doRegion(region.points, 6, signal);
            const a = worldToSurface(region.start, camera), b = worldToSurface(region.end, camera);
            return options.region.region({ kind: 'polygon', containment: region.containment, localToSurface: IDENTITY,
                points: [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }] }, signal);
        },
        preview(value) { regionPreview = value; if (!value) previewIds.clear(); if ((!value || value.kind === 'marquee') && current()) writeRegion(options.camera().camera); requestFrame(); },
        beginTransform(sample, _hit, modifiers) {
            check(); const ids = runtime.selection.getSnapshot().selected, revision = doc.rev;
            return translationHandleGesture(sample, modifiers, { runtime, ids, current: () => mutable() && doc.rev === revision,
                zoom: () => options.camera().camera.z, alwaysSnap: options.alwaysSnap ?? (() => false) }, {
                hold: () => session.beginGesture(), registerPending, current: () => mutable() && doc.rev === revision,
                show: (ops, live) => showTransform(ops, live === true), waitUntilReady: options.preview.waitUntilReady,
                armCommit: options.preview.armCommit, finishCommit: options.preview.finishCommit, cancelCommit: options.preview.cancelCommit,
                guides: setGuides, clear() { setGuides([]); clearTransform(); }, error: report,
            });
        },
        onError: report,
    };
    const presentAndCommit = async (ops: readonly Op[], signal: AbortSignal, active: () => boolean, commit: () => void) => {
        if (!ops.length) { commit(); return; }
        showTransform(ops);
        try {
            await options.preview.waitUntilReady(signal);
            signal.throwIfAborted(); if (!active()) throw new DOMException('Keyboard transform became stale', 'AbortError');
            options.preview.armCommit();
            try { commit(); options.preview.finishCommit(); }
            catch (error) { options.preview.cancelCommit(); throw error; }
        } finally { clearTransform(); }
    };
    const nudge = (key: string, coarse: boolean): boolean => {
        const direction: Record<string, Vec2> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
            ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
        const delta = direction[key], selection = runtime.selection.getSnapshot();
        if (!mutable() || !delta || !selection.selected.length) return false;
        const epoch = nudgeEpoch, owner = session.owner, ids = [...selection.selected];
        const scale = doc.view.grid ? (coarse ? 50 : BOARD_GRID_STEP) : (coarse ? 10 : 1);
        // Repeated key presses queue individual history steps rather than racing immutable snapshots.
        nudgeTail = nudgeTail.catch(() => {}).then(async () => {
            if (epoch !== nudgeEpoch || !mutable() || session.owner !== owner || session.doc !== doc
                || runtime.selection.getSnapshot() !== selection) return;
            const revision = doc.rev, controller = new AbortController(), release = session.beginGesture();
            let unregister: (() => void) | undefined, plan: Awaited<ReturnType<typeof createBoardTranslationPlan>> | undefined;
            const active = () => !controller.signal.aborted && epoch === nudgeEpoch && mutable() && session.owner === owner
                && session.doc === doc && doc.rev === revision && runtime.selection.getSnapshot() === selection;
            try {
                unregister = registerPending(() => controller.abort());
                await options.preview.waitUntilIdle(controller.signal);
                if (!active()) throw new DOMException('Keyboard nudge became stale', 'AbortError');
                plan = await createBoardTranslationPlan({ runtime, ids, down: { x: 0, y: 0 }, zoom: () => options.camera().camera.z,
                    alwaysSnap: () => false, current: active, signal: controller.signal });
                const preview = await plan.preview({ x: delta.x * scale, y: delta.y * scale }, false, false, controller.signal);
                const notebook = preview.ops.length ? await prepareNotebookTranslation({ runtime, ids, preview, signal: controller.signal, current: active }) : null;
                try {
                    const drop = preview.ops.length ? await prepareFrameDrop({ runtime, ids, preview: notebook?.preview ?? preview, signal: controller.signal, current: active }) : null;
                    try {
                        if (active()) {
                            const movement = notebook?.ops ?? preview.ops, ops = drop ? [...movement, ...drop.ops] : movement;
                            await presentAndCommit(ops, controller.signal, active, () => {
                                if (!drop && !notebook) { plan!.commit(preview); return; }
                                const applied = session.apply({ origin: 'tool', label: 'Move selection', ops }); applied.release();
                                plan!.cancel();
                            });
                        }
                    } finally { drop?.release(); }
                } finally { notebook?.release(); }
            } catch (error) { if (active()) report(error); }
            finally { try { plan?.cancel(); } finally { try { unregister?.(); } finally { release(); } } }
        });
        return true;
    };
    const transform = (command: string): boolean => {
        // Fine rotation is one sixteenth of the 15° keyboard step.
        const angles: Record<string, number> = { 'rotate.clockwise': Math.PI / 12, 'rotate.counterclockwise': -Math.PI / 12,
            'rotate.fineClockwise': Math.PI / 192, 'rotate.fineCounterclockwise': -Math.PI / 192 };
        const flip = command === 'flip.horizontal' ? 'x' : command === 'flip.vertical' ? 'y' : null;
        const stretch = command === 'stretch.horizontal' ? 'x' : command === 'stretch.vertical' ? 'y' : null;
        const factor = command === 'scale.enlarge' ? 1.1 : command === 'scale.shrink' ? 1 / 1.1 : null;
        if (!(command in angles) && !flip && !stretch && factor === null) return false;
        const selection = runtime.selection.getSnapshot();
        if (!mutable()) return viewRefused();
        if (!selection.selected.length) return false;
        const epoch = nudgeEpoch, owner = session.owner, ids = [...selection.selected];
        // Keyboard transforms share the nudge queue so no two preflights race the same revision.
        nudgeTail = nudgeTail.catch(() => {}).then(async () => {
            if (epoch !== nudgeEpoch || !mutable() || session.owner !== owner || session.doc !== doc
                || runtime.selection.getSnapshot() !== selection) return;
            const revision = doc.rev, controller = new AbortController(), release = session.beginGesture();
            let unregister: (() => void) | undefined;
            const active = () => !controller.signal.aborted && epoch === nudgeEpoch && mutable() && session.owner === owner
                && session.doc === doc && doc.rev === revision && runtime.selection.getSnapshot() === selection;
            try {
                unregister = registerPending(() => controller.abort());
                await options.preview.waitUntilIdle(controller.signal);
                if (!active()) throw new DOMException('Keyboard transform became stale', 'AbortError');
                if (stretch) {
                    await stretchBoardLeaves({ runtime, ids, axis: stretch, current: active, signal: controller.signal });
                    return;
                }
                if (factor !== null) {
                    const plan = await createBoardLeafResizePlan({ runtime, ids, down: { x: 0, y: 0 }, handle: { x: 1, y: 1 },
                        current: active, signal: controller.signal });
                    try {
                        const box = plan.startBox, c = Math.cos(box.rotation), s = Math.sin(box.rotation);
                        const dx = box.width * (factor - 1) / 2, dy = box.height * (factor - 1) / 2;
                        const result = await plan.preview({ x: c * dx - s * dy, y: s * dx + c * dy },
                            { shift: true, alt: true }, controller.signal);
                        const notebook = result.ops.length ? await prepareNotebookTransform({ runtime, ids, preview: result, signal: controller.signal, current: active }) : null;
                        try {
                            if (active()) await presentAndCommit(notebook?.ops ?? result.ops, controller.signal, active, () => {
                                if (!notebook) { plan.commit(result); return; }
                                const applied = session.apply({ origin: 'tool', label: 'Resize selection', ops: notebook.ops }); applied.release();
                                plan.cancel();
                            });
                        } finally { notebook?.release(); }
                    } finally { plan.cancel(); }
                    return;
                }
                const scope = await acquireBoardGeometryScope(runtime, ids, { signal: controller.signal, current: active });
                let centre: Vec2;
                try {
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, visited = 0;
                    for (const id of ids) {
                        const b = scope.logicalBounds(id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
                        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
                        if (++visited % 128 === 0) {
                            await new Promise<void>(resolve => setTimeout(resolve, 0));
                            if (!active()) throw new DOMException('Keyboard transform became stale', 'AbortError');
                        }
                    }
                    centre = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
                } finally { scope.release(); }
                if (!active()) return;
                if (flip) { await flipBoardLeaves({ runtime, ids, centre, axis: flip, current: active, signal: controller.signal }); return; }
                const angle = angles[command], down = { x: centre.x + 1, y: centre.y };
                const plan = await createBoardRotationPlan({ runtime, ids, centre, down, orientation: 0,
                    current: active, signal: controller.signal });
                try {
                    const preview = await plan.preview({ x: centre.x + Math.cos(angle), y: centre.y + Math.sin(angle) }, false, controller.signal);
                    const notebook = preview.ops.length ? await prepareNotebookTransform({ runtime, ids, preview, signal: controller.signal, current: active }) : null;
                    try {
                        if (active()) await presentAndCommit(notebook?.ops ?? preview.ops, controller.signal, active, () => {
                            if (!notebook) { plan.commit(preview); return; }
                            const applied = session.apply({ origin: 'tool', label: 'Rotate selection', ops: notebook.ops }); applied.release();
                            plan.cancel();
                        });
                    } finally { notebook?.release(); }
                } finally { plan.cancel(); }
            } catch (error) { if (active()) report(error); }
            finally { try { unregister?.(); } finally { release(); } }
        });
        return true;
    };
    const eraserSweep = sweep(true);
    // Every live erase's strokes, dimmed together: one can be landing while the next is drawn, and the preview is one
    // overlay. Each erase replaces or removes only its own set (a released erase that found nothing cleared the next
    // drag's dimming before).
    const erasing = new Map<object, ReadonlySet<NodeId>>();
    const showErasing = () => {
        const ids = new Set<NodeId>();
        for (const set of erasing.values()) for (const id of set) if (doc.nodes.has(id)) ids.add(id);
        if (ids.size) options.preview.showOps([...ids].map(id => ({ t: 'set', id, key: 'opacity', value: 0.5 } as const)));
        else options.preview.clear();
        requestFrame();
    };
    // A revision that moves while an erase is prepared is prepared again. These are bounded only so a board that changes
    // without pause cannot hold an erase forever; each one waits on a real change.
    const ERASE_ATTEMPTS = 32;
    const eraser: EraserContext = {
        ...eraserSweep, hold: () => session.beginGesture(), settle: () => session.beginGesture('settling'), registerSettling,
        previewErase(owner, ids) {
            if (ids.size) erasing.set(owner, ids); else if (!erasing.delete(owner)) return;
            showErasing();
        },
        clearPreview(owner) { if (erasing.delete(owner)) showErasing(); },
        // The sweep's hits are the strokes the person touched, at the revision they saw. A change since (the tool switch
        // writes ui.tool, the previous erase lands, an undo) does not undo that touch: the strokes still present are erased,
        // with geometry pinned at the revision they are erased in. It was abandoned as "Erase source changed" before
        // (measured: erase then an immediate click on Draw kept the strokes in 8 of 10 runs).
        async commitErase(owner, ids, signal) {
            const sheet = runtime.selection.getSnapshot().sheet;
            for (let attempt = 1; ; attempt++) {
                check(signal);
                // The previous erase's commit owns the preview until its frame is presented; this one is built after it.
                await options.preview.waitUntilIdle(signal);
                check(signal);
                if (runtime.selection.getSnapshot().sheet !== sheet) throw new DOMException('The erased page is no longer shown', 'AbortError');
                const live = new Set<NodeId>();
                for (const id of ids) if (doc.nodes.has(id)) live.add(id);
                if (!live.size) return;
                const revision = doc.rev, owned = session.owner;
                const active = () => !signal.aborted && mutable() && session.owner === owned && session.doc === doc && doc.rev === revision;
                let lease: { release(): void } | undefined;
                try {
                    lease = await render.pinChangeGeometry(live, signal, doc, active);
                    if (active()) {
                        erasing.set(owner, live); showErasing();
                        await options.preview.waitUntilReady(signal);
                    }
                } catch (error) {
                    lease?.release();
                    if (!isCancellation(error) || signal.aborted || !mutable() || attempt >= ERASE_ATTEMPTS) throw error;
                    continue;
                }
                try {
                    if (!active()) { if (attempt >= ERASE_ATTEMPTS) throw new DOMException('The board kept changing', 'AbortError'); continue; }
                    options.preview.armCommit();
                    try {
                        const builder = session.begin('tool', 'Erase');
                        try { planDelete(doc, builder, sheet, [...live], render.changeGeometry); builder.commit().release(); }
                        catch (error) { builder.abort(); throw error; }
                        options.preview.finishCommit();
                    } catch (error) { options.preview.cancelCommit(); throw error; }
                    return;
                } finally { lease!.release(); }
            }
        },
        error: report,
    };
    // Show grid is the lattice snapping uses (boardSnapGrid), drawn under the handles and guides. Its period doubles while one
    // cell is under 8 CSS px, so a zoomed-out board stays legible and the line count stays bounded at every zoom.
    let gridSvg: SVGSVGElement | null = null, gridPath: SVGPathElement | null = null;
    // The grid's camera and viewport, as five numbers (x, y, z, width, height); NaN until drawn.
    const gridCamera = new Float64Array(5).fill(Number.NaN);
    const drawGrid = (frame: ScheduledFrame) => {
        const lattice = boardSnapGrid(runtime.session.doc);
        if (!lattice) { gridSvg?.remove(); gridSvg = null; gridPath = null; gridCamera.fill(Number.NaN); return; }
        const { camera, viewport } = frame.view;
        if (!(camera.z > 0) || !Number.isFinite(camera.z)) return;
        if (!gridSvg || !gridPath) {
            gridSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            gridSvg.setAttribute('aria-hidden', 'true');
            gridSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden';
            gridPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            gridPath.setAttribute('fill', 'none'); gridPath.setAttribute('stroke', 'currentColor');
            gridPath.setAttribute('stroke-opacity', '0.14'); gridPath.setAttribute('shape-rendering', 'crispEdges');
            gridSvg.append(gridPath); options.overlay.prepend(gridSvg); gridCamera.fill(Number.NaN);
        }
        const seen = gridCamera;
        if (seen[0] === camera.x && seen[1] === camera.y && seen[2] === camera.z && seen[3] === viewport.width && seen[4] === viewport.height) return;
        seen[0] = camera.x; seen[1] = camera.y; seen[2] = camera.z; seen[3] = viewport.width; seen[4] = viewport.height;
        const z = camera.z;
        let period = lattice.step.x;
        while (period * z < 8) period *= 2;
        const right = camera.x + viewport.width / z, bottom = camera.y + viewport.height / z;
        let d = '';
        for (let x = lattice.origin.x + Math.floor((camera.x - lattice.origin.x) / period) * period; x <= right; x += period) {
            d += `M${(x - camera.x) * z} 0V${viewport.height}`;
        }
        for (let y = lattice.origin.y + Math.floor((camera.y - lattice.origin.y) / period) * period; y <= bottom; y += period) {
            d += `M0 ${(y - camera.y) * z}H${viewport.width}`;
        }
        gridPath.setAttribute('d', d);
    };
    /** The region preview (marquee or scribble) in its own SVG. A marquee is written when its preview changes, with the live
     * camera, so the wash follows the pointer even while the GPU frame is deferred (its overlays are otherwise written only
     * with a submitted frame, and a stalled board froze the wash for the whole drag). A scribble is still written per frame. */
    // The shape's attributes are written when their value changes, and its style once per kind. By reading: a frame used to
    // re-set the stroke, fill, dash and width, and the marquee's four numbers, whether or not any had moved.
    let shapeMode: 'rect' | 'g' | null = null, shapeStroke = '';
    const shapeBox = new Float64Array(4).fill(Number.NaN);
    const writeRegion = (camera: ViewState['camera']) => {
        if (!regionPreview) {
            svg?.remove(); svg = null; shape = null; shapeMode = null; scribbleSource = null; scribbleCount = 0;
            scribbleTail = null; scribblePoints = []; forgetCamera(scribbleCamera); return;
        }
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('aria-hidden', 'true'); svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
            options.overlay.append(svg);
        }
        const kind = regionPreview.kind === 'marquee' ? 'rect' : 'g';
        if (!shape || shape.localName !== kind) {
            shape?.remove(); shape = document.createElementNS('http://www.w3.org/2000/svg', kind); svg.append(shape);
            shapeMode = null; shapeStroke = ''; shapeBox.fill(Number.NaN);
            scribbleSource = null; scribbleCount = 0; scribbleTail = null; scribblePoints = []; forgetCamera(scribbleCamera);
        }
        const stroke = previewIds.size ? '#75b7ff' : '#6a9fff';
        if (shapeStroke !== stroke) { shapeStroke = stroke; shape.setAttribute('stroke', stroke); }
        if (shapeMode !== kind) {
            shapeMode = kind; shape.setAttribute('stroke-width', '1.5');
            if (kind === 'rect') { shape.setAttribute('fill', 'rgba(106,159,255,0.12)'); shape.setAttribute('stroke-dasharray', '4 3'); }
            else { shape.setAttribute('fill', 'none'); shape.removeAttribute('stroke-dasharray'); }
        }
        if (regionPreview.kind === 'marquee') {
            const a = worldToSurface(regionPreview.start, camera), b = worldToSurface(regionPreview.end, camera);
            const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), width = Math.abs(a.x - b.x), height = Math.abs(a.y - b.y);
            if (shapeBox[0] !== x) { shapeBox[0] = x; shape.setAttribute('x', String(x)); }
            if (shapeBox[1] !== y) { shapeBox[1] = y; shape.setAttribute('y', String(y)); }
            if (shapeBox[2] !== width) { shapeBox[2] = width; shape.setAttribute('width', String(width)); }
            if (shapeBox[3] !== height) { shapeBox[3] = height; shape.setAttribute('height', String(height)); }
        } else {
            const source = regionPreview.points;
            // Checked first and unconditionally: the cache must track the camera even on a frame that rebuilds for another reason.
            const cameraMoved = cameraChanged(scribbleCamera, camera);
            if (scribbleSource !== source || cameraMoved || scribbleCount > source.length) {
                shape.replaceChildren(); scribbleSource = source; scribbleCount = 0;
                scribbleTail = null; scribblePoints = [];
            }
            // Keep exact points, but bound DOM projection to four small chunks per shared frame.
            const limit = Math.min(source.length, scribbleCount + 1024);
            while (scribbleCount < limit) {
                if (!scribbleTail || scribblePoints.length >= 257) {
                    scribbleTail = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
                    scribbleTail.setAttribute('stroke-linejoin', 'round'); scribbleTail.setAttribute('stroke-linecap', 'round');
                    shape.append(scribbleTail); scribblePoints = [];
                    if (scribbleCount) {
                        const previous = worldToSurface(source[scribbleCount - 1], camera); scribblePoints.push(`${previous.x},${previous.y}`);
                    }
                }
                const remaining = Math.min(limit - scribbleCount, 257 - scribblePoints.length);
                for (let i = 0; i < remaining; i++) {
                    const p = worldToSurface(source[scribbleCount++], camera); scribblePoints.push(`${p.x},${p.y}`);
                }
                scribbleTail.setAttribute('points', scribblePoints.join(' '));
            }
            if (scribbleCount < source.length) requestFrame();
        }
    };
    const writeOverlays = (frame: ScheduledFrame) => {
        if (!current() || frame.token.vaultEpoch !== token.vaultEpoch || frame.token.documentId !== token.documentId
            || frame.token.bytesGeneration !== token.bytesGeneration || frame.token.session !== token.session) return;
        overlaysFramed = true;
        drawGrid(frame);
        navigation.present(frame); selectionHandles.write(frame, transformPreview ? transformOffset ?? 'hidden' : null); shapeHandles.write(frame, transformOffset); stickyHandles.write(frame, transformOffset); cardControls.write(frame); backToContent.update(frame);
        writeGuides(frame.view.camera);
        writeRegion(frame.view.camera);
    };
    // One line per guide, kept and moved: a frame writes a line's ends only when they changed. By reading: the frame used to
    // replace every line with a new element each time it was written, which is what the drag's guides did at every move.
    let guideLines: { readonly line: SVGLineElement; readonly last: Float64Array }[] = [];
    const writeGuides = (camera: ViewState['camera']) => {
        if (!guides.length) { guideSvg?.remove(); guideSvg = null; guideLines = []; return; }
        if (!guideSvg) {
            guideSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            guideSvg.setAttribute('aria-hidden', 'true'); guideSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
            options.overlay.append(guideSvg); guideLines = [];
        }
        for (let i = 0; i < guides.length; i++) {
            const guide = guides[i];
            const from = guide.axis === 'x' ? { x: guide.value, y: guide.from } : { x: guide.from, y: guide.value };
            const to = guide.axis === 'x' ? { x: guide.value, y: guide.to } : { x: guide.to, y: guide.value };
            const a = worldToSurface(from, camera), b = worldToSurface(to, camera);
            let entry = guideLines[i];
            if (!entry) {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('stroke', '#f276bd'); line.setAttribute('stroke-width', '1'); guideSvg.append(line);
                entry = { line, last: new Float64Array(4).fill(Number.NaN) }; guideLines.push(entry);
            }
            const v = entry.last;
            if (v[0] !== a.x) { v[0] = a.x; entry.line.setAttribute('x1', String(a.x)); }
            if (v[1] !== a.y) { v[1] = a.y; entry.line.setAttribute('y1', String(a.y)); }
            if (v[2] !== b.x) { v[2] = b.x; entry.line.setAttribute('x2', String(b.x)); }
            if (v[3] !== b.y) { v[3] = b.y; entry.line.setAttribute('y2', String(b.y)); }
        }
        while (guideLines.length > guides.length) guideLines.pop()!.line.remove();
    };
    const beginHandle = (sample: RealSample, modifiers: Modifiers): GestureOwner | null => {
        // A card's chips need no write right: consent to load an embed, and opening a link, change no document.
        const chip = cardControls.begin(physicalSurface(sample), sample, modifiers.accel);
        if (chip) return chip;
        if (!mutable()) return null;
        const surface = physicalSurface(sample), coarse = sample.source === 'touch';
        const shapeHit = shapeHandles.hit(surface, coarse, sample.time);
        if (shapeHit) return shapeHandles.begin(shapeHit, sample, modifiers);
        const direction = stickyHandles.hit(surface, coarse, sample.time);
        if (!direction) {
            const hit = selectionHandles.hit(surface, coarse, sample.time); if (!hit) return null;
            const ids = [...runtime.selection.getSnapshot().selected], host = {
                hold: () => session.beginGesture(), registerPending, current: mutable,
                show: (ops: readonly Op[]) => showTransform(ops), waitUntilReady: options.preview.waitUntilReady,
                armCommit: options.preview.armCommit, finishCommit: options.preview.finishCommit, cancelCommit: options.preview.cancelCommit,
                guides: setGuides, clear: () => { setGuides([]); clearTransform(); }, error: report,
            };
            if (hit.kind === 'rotate') return rotationHandleGesture(sample, modifiers,
                { runtime, ids, centre: hit.centre, orientation: hit.orientation, current: mutable }, host);
            return leafResizeHandleGesture(sample, modifiers, { runtime, ids, handle: hit.handle, current: mutable }, host,
                { zoom: () => options.camera().camera.z, alwaysSnap: options.alwaysSnap ?? (() => false) });
        }
        const release = session.beginGesture(), pointerIds = new Set([sample.pointerId]), down = surface;
        let ended = false, cancelled = false, cleaned = false, unregister: (() => void) | undefined;
        const cleanup = () => { if (cleaned) return; cleaned = true; unregister?.(); unregister = undefined; release(); };
        const cancel = () => { if (cancelled) return; cancelled = true; ended = true; stickyHandles.hide(); cleanup(); };
        try { unregister = registerPending(cancel); } catch (error) { release(); throw error; }
        return { kind: 'node-edit', pointerIds,
            update(samples) { for (const next of samples) if (pointerIds.has(next.pointerId)) {
                const point = physicalSurface(next); if (Math.hypot(point.x - down.x, point.y - down.y) >= 4) cancel();
            } },
            finish(reason) {
                if (ended || cancelled) return; ended = true;
                if (reason !== 'up' || !mutable()) { cancel(); return; }
                void stickyHandles.activate(direction, sample.source === 'keyboard').finally(cleanup);
            },
            cancel,
        };
    };
    const navigate = (command: string): boolean => {
        if (!current()) return false;
        if (command === 'select.next') return navigation.navigation.next(1);
        if (command === 'select.previous') return navigation.navigation.next(-1);
        if (command === 'select.child') return navigation.navigation.child();
        if (command === 'select.parent') return navigation.navigation.parent();
        const directions = { 'select.neighbour.ArrowLeft': 'left', 'select.neighbour.ArrowRight': 'right',
            'select.neighbour.ArrowUp': 'up', 'select.neighbour.ArrowDown': 'down' } as const;
        const direction = directions[command as keyof typeof directions];
        if (!direction) return false;
        void navigation.navigation.cardinal(direction).catch(error => {
            if (!isCancellation(error)) report(error);
        });
        return true;
    };
    const stickyNeighbour = (direction: StickyDirection): boolean => {
        if (!mutable()) return false;
        const selection = runtime.selection.getSnapshot();
        const node = selection.selected.length === 1 ? doc.nodes.get(selection.selected[0]) : undefined;
        if (!node || node.kind !== 'sticky' || isLocked(doc, node)) return false;
        const release = session.beginGesture();
        let unregister: (() => void) | undefined;
        try { unregister = registerPending(() => stickyHandles.hide()); }
        catch (error) { release(); throw error; }
        void stickyHandles.activate(direction, true).finally(() => { try { unregister?.(); } finally { release(); } });
        return true;
    };
    const doubleClickHandle = (surface: Vec2, world: Vec2, time?: number): boolean => {
        if (!mutable()) return false;
        const hit = shapeHandles.hit(surface, false, time);
        if (hit && shapeHandles.toggleHead(hit)) return true;
        if (!selectionHandles.contains(world, time)) return false;
        return enterGroupAtPoint({ runtime, point: world, current: mutable, hold: () => session.beginGesture(), registerPending,
            hit: (point, signal) => options.point.hit(point, 'mouse', signal), error: report });
    };
    const handleCommand = (id: string, sample: RealSample): boolean => {
        if (id !== 'delete' || sample.source !== 'keyboard' || !mutable()) return false;
        const hit = shapeHandles.hit(physicalSurface(sample), false, sample.time);
        return hit ? shapeHandles.remove(hit) : false;
    };
    const cameraCommands = createBoardCameraCommands({ runtime, camera: options.cameraController, surface: options.surface,
        current, changed: options.cameraChanged, error: report });
    const backToContent = createBackToContent({ runtime, overlay: options.overlay, surface: options.surface, current,
        activate: () => { cameraCommands.run('camera.backToContent'); }, error: report });
    const keyboardContext = options.openKeyboardContextMenu ? createKeyboardContext({ runtime, camera: options.cameraController,
        surface: options.surface, current, open: options.openKeyboardContextMenu, error: report }) : null;
    const keyboardContextMenu = (surface: Vec2, world: Vec2) => keyboardContext?.request(surface, world) ?? false;
    /** The locked node a secondary click at this world point targets, without selecting it (F-CTX-006). */
    const lockedAt = (world: Vec2, signal: AbortSignal) => options.point.hitLocked(world, 'mouse', signal);
    const selectionCommands = createSelectionCommandDriver({ runtime, zoom: () => options.camera().camera.z, current,
        canMutateView: options.canMutateView, registerPending, error: report, keptLocked: options.onKeptLocked });
    const styleShortcuts = createStyleShortcuts({ runtime, inputToken: options.inputToken,
        hit: (point, signal) => options.point.hit(point, 'mouse', signal), current, canMutateView: options.canMutateView,
        registerPending, error: report, toggleWhiteboardTheme: options.toggleWhiteboardTheme });
    const command = (id: string): boolean => {
        if (cameraCommands.run(id) || selectionCommands.run(id) || styleShortcuts.run(id)) return true;
        if (id.startsWith('nudge.coarse.')) return nudge(id.slice('nudge.coarse.'.length), true) || viewRefused();
        if (id.startsWith('nudge.')) return nudge(id.slice('nudge.'.length), false) || viewRefused();
        return navigate(id) || transform(id);
    };
    // The host routes select through this tool so handles win over body picking for both pointer and keyboard input.
    const selectContext: BoardSelectGestureContext = { ...select, sampleToSurface: physicalSurface, beginHandle,
        settle: () => session.beginGesture('settling'), registerSettling, settled,
        insideSelection: sample => selectionHandles.contains({ x: sample.x, y: sample.y }, sample.time),
        // The selection's picture is built at rest when a press lands on it: a drag's first move then only moves that picture,
        // and a build takes frames that the first move cannot wait for.
        prewarm() {
            const rest: Op[] = [];
            for (const id of runtime.selection.getSnapshot().selected) { const node = runtime.session.doc.nodes.get(id); if (node) rest.push({ t: 'set', id, key: 'x', value: node.x }); }
            if (rest.length) options.preview.showOps(rest, true);
        } };
    const tool = { id: boardSelectTool.id, begin(sample: RealSample, modifiers: Modifiers) {
        return boardSelectTool.begin(sample, modifiers, selectContext);
    } };
    return { select, tool, eraser, beginHandle, doubleClickHandle, handleCommand, keyboardContextMenu, lockedAt, nudge, transform, navigate, command, stickyNeighbour, setGuides, navigation, writeOverlays: (frame: ScheduledFrame) => auditTimed('select-overlay', () => writeOverlays(frame)), cancelPending, cancelSettling,
        /** A released erase still landing shows its strokes dimmed: a new press must not clear that overlay. */
        holdsPreview: () => erasing.size > 0,
        dispose() { if (disposed) return; cancelPending(); cancelSettling(false); for (const controller of controllers) controller.abort(); controllers.clear(); disposed = true; keyboardContext?.dispose(); backToContent.dispose(); cameraCommands.dispose(); selectionCommands.dispose(); styleShortcuts.dispose(); navigation.dispose(); selectionHandles.dispose(); shapeHandles.dispose(); stickyHandles.dispose(); cardControls.dispose(); scheduled?.(); scheduled = null; options.preview.clear(); svg?.remove(); guideSvg?.remove(); guideSvg = null; svg = null; shape = null;
            regionPreview = null; scribbleSource = null; scribbleTail = null; scribblePoints = []; scribbleCount = 0; },
    };
}
