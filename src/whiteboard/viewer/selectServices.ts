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
import { createBoardTranslationPlan } from '../geom/runtimeTranslation';
import { createBoardRotationPlan } from '../geom/runtimeTransforms';
import { createBoardLeafResizePlan } from '../geom/runtimeLeafPlan';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { EraserContext } from '../input/basicTools';
import type { SweptSelectionCursor, SweepPoint, SweepQueueServices } from '../input/sweepQueue';
import type { NodeId } from '../model/ids';
import { sampleSurface, type GestureOwner, type InputToken, type Modifiers, type RealSample } from '../input/tool';
import { leafResizeHandleGesture, rotationHandleGesture, translationHandleGesture } from '../input/transformGestures';
import type { createBoardRenderServices } from '../render/services';
import { selectTool, type SelectRegion, type SelectToolContext } from '../tools/select';
import type { createBoardPointQuery } from './pointQuery';
import type { createBoardRegionQuery } from './regionQuery';
import { createBoardAttachmentResolver } from './attachments';
import { createShapeHandles } from './shapeHandles';
import { createStickyHandles } from './stickyHandles';
import { createSelectionHandles } from './selectionHandles';
import { createBoardSelectionNavigation } from './selectionNavigation';
import type { BoardPreview } from './preview';

// Provenance: SelectGesture, swept selection, geometry preparation, transaction
// and shared frame contracts; independent host composition, no third-party source.
export interface BoardSelectServicesOptions {
    readonly runtime: BoardRuntime;
    readonly render: Pick<ReturnType<typeof createBoardRenderServices>, 'prepareChangeGeometry' | 'changeGeometry'>;
    readonly camera: () => ViewState;
    readonly cameraController: CameraController;
    readonly surface: HTMLElement;
    readonly inputToken: InputToken;
    readonly cameraChanged: () => void;
    /** Convert a physical sample using the mapping that actually presented it. */
    readonly sampleToSurface: (sample: RealSample) => Vec2;
    readonly point: Pick<ReturnType<typeof createBoardPointQuery>, 'hit' | 'hitTarget'>;
    readonly region: Pick<ReturnType<typeof createBoardRegionQuery>, 'region'>;
    readonly preview: Pick<BoardPreview, 'showOps' | 'waitUntilReady' | 'armCommit' | 'finishCommit' | 'cancelCommit' | 'clear'>;
    readonly overlay: HTMLElement;
    readonly token: RenderToken;
    current(token: RenderToken): boolean;
    readonly inputFrames: { schedule(callback: () => void): () => void };
    readonly editSticky: (id: NodeId) => void | Promise<void>;
    readonly alwaysSnap?: () => boolean;
    onError(error: unknown): void;
}
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
export function createBoardSelectServices(options: BoardSelectServicesOptions) {
    const { runtime, render } = options, session = runtime.session, doc = session.doc;
    const token = Object.freeze({ ...options.token });
    const pending = new Set<() => void>(), controllers = new Set<AbortController>();
    let disposed = false, regionPreview: SelectRegion | null = null, previewIds = new Set<NodeId>();
    let svg: SVGSVGElement | null = null, shape: SVGElement | null = null, guideSvg: SVGSVGElement | null = null, scheduled: (() => void) | null = null;
    let guides: readonly BoardSnapGuide[] = [];
    let warmedRevision = -1, warmed = new Set<NodeId>();
    let nudgeEpoch = 0, nudgeTail: Promise<void> = Promise.resolve();
    const current = () => !disposed && options.current(token);
    const mutable = () => current() && !session.isReadOnly;
    const report = (error: unknown) => { try { options.onError(error); } catch { /* Preserve the original operation failure. */ } };
    const requestFrame = () => {
        if (disposed || scheduled) return;
        scheduled = options.inputFrames.schedule(() => { scheduled = null; });
    };
    const registerPending = (cancel: () => void) => {
        if (!mutable()) throw new DOMException('Board input is no longer current', 'AbortError');
        pending.add(cancel); return () => { pending.delete(cancel); };
    };
    const cancelPending = () => {
        nudgeEpoch++;
        navigation.cancel();
        const work = [...pending], had = work.length > 0 || controllers.size > 0;
        pending.clear(); for (const cancel of work) { try { cancel(); } catch (error) { report(error); } }
        for (const controller of controllers) controller.abort(); controllers.clear();
        return had;
    };
    const setGuides = (value: readonly BoardSnapGuide[]) => { guides = value; requestFrame(); };
    const toSurface = (point: Vec2) => worldToSurface(point, options.camera().camera);
    const physicalSurface = (sample: RealSample) => sampleSurface(sample, options.sampleToSurface);
    const attachments = createBoardAttachmentResolver({ runtime, render: runtime.render, point: options.point, camera: options.camera, current: mutable });
    const shapeHandles = createShapeHandles({ runtime, overlay: options.overlay, view: options.camera, current: mutable, visible: mutable,
        sampleToSurface: physicalSurface, invalidate: requestFrame, hold: () => session.beginGesture(), registerPending,
        show: ops => options.preview.showOps(ops), waitUntilReady: options.preview.waitUntilReady,
        armCommit: options.preview.armCommit, finishCommit: options.preview.finishCommit, cancelCommit: options.preview.cancelCommit,
        clear: () => options.preview.clear(), resolveAttachment: (point, signal, request) => attachments.resolve(point, signal, request), error: report });
    const stickyHandles = createStickyHandles({ runtime, overlay: options.overlay, view: options.camera, current: mutable, visible: mutable,
        invalidate: requestFrame, edit: options.editSticky, error: report });
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
        selection: runtime.selection, dragThresholdCss: 4, scribble: sweep(false),
        hold: () => session.beginGesture(), registerPending, toSurface, isCurrent: mutable,
        async hit(sample, signal) {
            check(signal); const revision = doc.rev;
            const point = { x: sample.x, y: sample.y }, input = sample.source === 'keyboard' ? 'mouse' : sample.source;
            const id = await options.point.hit(point, input, signal); check(signal);
            const ids = new Set(runtime.selection.getSnapshot().selected); if (id) ids.add(id);
            await render.prepareChangeGeometry(ids, signal); check(signal);
            if (doc.rev !== revision) throw new DOMException('Board changed during selection preflight', 'AbortError');
            warmedRevision = revision; warmed = ids;
            return id;
        },
        async region(region, signal) {
            check(signal); const camera = options.camera().camera;
            if (region.kind === 'scribble') return doRegion(region.points, 6, signal);
            const a = worldToSurface(region.start, camera), b = worldToSurface(region.end, camera);
            return options.region.region({ kind: 'polygon', containment: region.containment, localToSurface: IDENTITY,
                points: [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }] }, signal);
        },
        preview(value) { regionPreview = value; if (!value) previewIds.clear(); requestFrame(); },
        beginTransform(sample, hit, modifiers) {
            check(); const ids = runtime.selection.getSnapshot().selected, revision = doc.rev;
            if (warmedRevision !== revision || !warmed.has(hit) || ids.some(id => !warmed.has(id))) throw new Error('Selection geometry is not preflighted');
            return translationHandleGesture(sample, modifiers, { runtime, ids, current: () => mutable() && doc.rev === revision,
                zoom: () => options.camera().camera.z, alwaysSnap: options.alwaysSnap ?? (() => false) }, {
                hold: () => session.beginGesture(), registerPending, current: () => mutable() && doc.rev === revision,
                show: ops => options.preview.showOps(ops), waitUntilReady: options.preview.waitUntilReady,
                armCommit: options.preview.armCommit, finishCommit: options.preview.finishCommit, cancelCommit: options.preview.cancelCommit,
                guides: setGuides, clear() { setGuides([]); options.preview.clear(); }, error: report,
            });
        },
        onError: report,
    };
    const nudge = (key: string, coarse: boolean): boolean => {
        const direction: Record<string, Vec2> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
            ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
        const delta = direction[key], selection = runtime.selection.getSnapshot();
        if (!mutable() || !delta || !selection.selected.length) return false;
        const epoch = nudgeEpoch, owner = session.owner, ids = [...selection.selected], scale = coarse ? 10 : 1;
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
                plan = await createBoardTranslationPlan({ runtime, ids, down: { x: 0, y: 0 }, zoom: () => options.camera().camera.z,
                    alwaysSnap: () => false, current: active, signal: controller.signal });
                const preview = await plan.preview({ x: delta.x * scale, y: delta.y * scale }, false, false, controller.signal);
                if (active()) plan.commit(preview);
            } catch (error) { if (active()) report(error); }
            finally { try { plan?.cancel(); } finally { try { unregister?.(); } finally { release(); } } }
        });
        return true;
    };
    const transform = (command: string): boolean => {
        // Default: coarse rotation is 15°, fine rotation is 1°, and scale steps are 10%.
        const angles: Record<string, number> = { 'rotate.clockwise': Math.PI / 12, 'rotate.counterclockwise': -Math.PI / 12,
            'rotate.fineClockwise': Math.PI / 180, 'rotate.fineCounterclockwise': -Math.PI / 180 };
        const flip = command === 'flip.horizontal' ? 'x' : command === 'flip.vertical' ? 'y' : null;
        const stretch = command === 'stretch.horizontal' ? 'x' : command === 'stretch.vertical' ? 'y' : null;
        const factor = command === 'scale.enlarge' ? 1.1 : command === 'scale.shrink' ? 1 / 1.1 : null;
        if (!(command in angles) && !flip && !stretch && factor === null) return false;
        const selection = runtime.selection.getSnapshot();
        if (!mutable() || !selection.selected.length) return false;
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
                        if (active()) plan.commit(result);
                    } finally { plan.cancel(); }
                    return;
                }
                const scope = await acquireBoardGeometryScope(runtime, ids, { signal: controller.signal, current: active });
                let centre: Vec2;
                try {
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                    for (const id of ids) { const b = scope.logicalBounds(id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
                        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
                    centre = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
                } finally { scope.release(); }
                if (!active()) return;
                if (flip) { await flipBoardLeaves({ runtime, ids, centre, axis: flip, current: active, signal: controller.signal }); return; }
                const angle = angles[command], down = { x: centre.x + 1, y: centre.y };
                const plan = await createBoardRotationPlan({ runtime, ids, centre, down, orientation: 0,
                    current: active, signal: controller.signal });
                try {
                    const preview = await plan.preview({ x: centre.x + Math.cos(angle), y: centre.y + Math.sin(angle) }, false, controller.signal);
                    if (active()) plan.commit(preview);
                } finally { plan.cancel(); }
            } catch (error) { if (active()) report(error); }
            finally { try { unregister?.(); } finally { release(); } }
        });
        return true;
    };
    const eraserSweep = sweep(true);
    const eraser: EraserContext = {
        ...eraserSweep, hold: () => session.beginGesture(), registerPending,
        prepareCommit(ids, signal) {
            check(signal);
            options.preview.showOps([...ids].map(id => ({ t: 'set', id, key: 'opacity', value: 0.5 } as const)));
            return options.preview.waitUntilReady(signal);
        },
        armCommit: options.preview.armCommit, finishCommit: options.preview.finishCommit, cancelCommit: options.preview.cancelCommit,
        commit(ids) {
            check(); if (!ids.size) return;
            const builder = session.begin('tool', 'Erase');
            try { planDelete(doc, builder, runtime.selection.getSnapshot().sheet, [...ids], render.changeGeometry); const applied = builder.commit(); applied.release(); }
            catch (error) { builder.abort(); throw error; }
        },
        clearPreview() { previewIds.clear(); options.preview.clear(); requestFrame(); }, error: report,
    };
    const writeOverlays = (frame: ScheduledFrame) => {
        if (!current() || frame.token.vaultEpoch !== token.vaultEpoch || frame.token.documentId !== token.documentId
            || frame.token.bytesGeneration !== token.bytesGeneration || frame.token.session !== token.session) return;
        navigation.present(frame); selectionHandles.write(frame); shapeHandles.write(frame); stickyHandles.write(frame);
        if (guides.length) {
            if (!guideSvg) { guideSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                guideSvg.setAttribute('aria-hidden', 'true'); guideSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
                options.overlay.append(guideSvg); }
            guideSvg.replaceChildren();
            for (const guide of guides) {
                const from = guide.axis === 'x' ? { x: guide.value, y: guide.from } : { x: guide.from, y: guide.value };
                const to = guide.axis === 'x' ? { x: guide.value, y: guide.to } : { x: guide.to, y: guide.value };
                const a = worldToSurface(from, frame.view.camera), b = worldToSurface(to, frame.view.camera);
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y)); line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
                line.setAttribute('stroke', '#f276bd'); line.setAttribute('stroke-width', '1'); guideSvg.append(line);
            }
        } else { guideSvg?.remove(); guideSvg = null; }
        if (!regionPreview) { svg?.remove(); svg = null; shape = null; return; }
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('aria-hidden', 'true'); svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
            options.overlay.append(svg);
        }
        const kind = regionPreview.kind === 'marquee' ? 'rect' : 'polyline';
        if (!shape || shape.localName !== kind) { shape?.remove(); shape = document.createElementNS('http://www.w3.org/2000/svg', kind); svg.append(shape); }
        shape.setAttribute('stroke', previewIds.size ? '#75b7ff' : '#6a9fff'); shape.setAttribute('stroke-width', '1.5');
        if (regionPreview.kind === 'marquee') {
            const a = worldToSurface(regionPreview.start, frame.view.camera), b = worldToSurface(regionPreview.end, frame.view.camera);
            shape.setAttribute('x', String(Math.min(a.x, b.x))); shape.setAttribute('y', String(Math.min(a.y, b.y)));
            shape.setAttribute('width', String(Math.abs(a.x - b.x))); shape.setAttribute('height', String(Math.abs(a.y - b.y)));
            shape.setAttribute('fill', 'rgba(106,159,255,0.12)'); shape.setAttribute('stroke-dasharray', '4 3');
        } else {
            const points = regionPreview.points.map(point => worldToSurface(point, frame.view.camera));
            shape.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
            shape.setAttribute('fill', 'none'); shape.removeAttribute('stroke-dasharray');
        }
    };
    const beginHandle = (sample: RealSample, modifiers: Modifiers): GestureOwner | null => {
        if (!mutable()) return null;
        const surface = physicalSurface(sample), coarse = sample.source === 'touch';
        const shapeHit = shapeHandles.hit(surface, coarse);
        if (shapeHit) return shapeHandles.begin(shapeHit, sample, modifiers);
        const direction = stickyHandles.hit(surface, coarse);
        if (!direction) {
            const hit = selectionHandles.hit(surface, coarse); if (!hit) return null;
            const ids = [...runtime.selection.getSnapshot().selected], host = {
                hold: () => session.beginGesture(), registerPending, current: mutable,
                show: (ops: readonly Op[]) => options.preview.showOps(ops), waitUntilReady: options.preview.waitUntilReady,
                armCommit: options.preview.armCommit, finishCommit: options.preview.finishCommit, cancelCommit: options.preview.cancelCommit,
                clear: () => options.preview.clear(), error: report,
            };
            if (hit.kind === 'rotate') return rotationHandleGesture(sample, modifiers,
                { runtime, ids, centre: hit.centre, orientation: hit.orientation, current: mutable }, host);
            return leafResizeHandleGesture(sample, modifiers, { runtime, ids, handle: hit.handle, current: mutable }, host);
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
            if (!(error instanceof DOMException && error.name === 'AbortError')) report(error);
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
    const command = (id: string): boolean => {
        if (id.startsWith('nudge.coarse.')) return nudge(id.slice('nudge.coarse.'.length), true);
        if (id.startsWith('nudge.')) return nudge(id.slice('nudge.'.length), false);
        return navigate(id) || transform(id);
    };
    // The host routes select through this tool so handles win over body picking for both pointer and keyboard input.
    const tool = { id: selectTool.id, begin(sample: RealSample, modifiers: Modifiers) {
        return beginHandle(sample, modifiers) ?? selectTool.begin(sample, modifiers, select);
    } };
    return { select, tool, eraser, beginHandle, nudge, transform, navigate, command, stickyNeighbour, setGuides, navigation, writeOverlays, cancelPending,
        dispose() { if (disposed) return; cancelPending(); disposed = true; navigation.dispose(); selectionHandles.dispose(); shapeHandles.dispose(); stickyHandles.dispose(); scheduled?.(); scheduled = null; options.preview.clear(); svg?.remove(); guideSvg?.remove(); guideSvg = null; svg = null; shape = null; },
    };
}
