import { surfaceToWorld, worldToSurface, type CameraController, type Point } from '../../platform/render/camera';
import type { NodeId } from '../model/ids';
import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import type { ScheduledFrame, TouchPanSample } from '../../platform/render/scheduler';
import type { RenderToken } from '../../platform/render/types';
import type { PaintSource } from '../render/paintStream';
import { keptLockedMessage } from '../commands/delete';
import type { Camera, ViewState, Viewport } from '../../platform/types';
import type { BoardRuntime } from '../host/runtime';
import type { BoardInputServices } from '../input/attach';
import { eraserTool, laserTool, type LaserPoint } from '../input/basicTools';
import { textDropTool } from '../input/chromeDrag';
import { LaserTrail } from '../input/laserTrail';
import type { ToolChoice } from '../input/gesture';
import type { MappingHistory } from '../input/pointer';
import type { PointerRoute } from '../input/pointerRouter';
import type { InputToken, Modifiers, RealSample, Tool } from '../input/tool';
import type { ZoomBox, ZoomBrushContext } from '../input/zoomBrush';
import { zoomBrushTool } from '../input/zoomBrush';
import { stepBoardZoom } from '../input/cameraZoom';
import { FIGURE_SHAPES, type FigureShape } from '../model/styles';
import type { PaintImageProvider } from '../render/resources';
import { textTool } from '../text/edit/tool';
import { createBoardAttachmentResolver } from './attachments';
import { boardCreationTool } from './creationTools';
import { contentBounds, type ContentRect } from '../commands/contentBounds';
import { notePointerSource } from './pointerKind';
import { createBoardInkServices } from './inkServices';
import type { KeyboardContextRequest } from './keyboardContext';
import { createBoardPointQuery } from './pointQuery';
import { createBoardPreview } from './preview';
import { createBoardRegionQuery } from './regionQuery';
import { createBoardSelectServices } from './selectServices';
import { createBoardTextEditor, type BoardTextEditorOptions } from './textEditor';
import { createSensitiveTargets } from './sensitiveTargets';
import type { ViewerEngine } from './types';
import type { BoardCardActions } from './cardControls';
import { isCancellation } from '../../platform/workers/envelope';
import { yieldToHost } from '../../platform/yieldToHost';

export interface BoardContextMenuRequest { readonly point: { readonly x: number; readonly y: number }; readonly opener: HTMLElement; readonly locked: NodeId | null }
export interface BoardToolServicesOptions {
    readonly runtime: BoardRuntime;
    readonly engine: ViewerEngine;
    readonly spelling: BoardTextEditorOptions['spelling'];
    readonly images: PaintImageProvider;
    readonly camera: CameraController;
    readonly view: () => ViewState;
    readonly viewport: () => Viewport;
    readonly surface: HTMLElement;
    readonly overlay: HTMLElement;
    readonly token: RenderToken;
    readonly inputToken: InputToken;
    readonly current: (token: RenderToken) => boolean;
    readonly editable: () => boolean;
    readonly visible: () => boolean;
    readonly focused: () => boolean;
    readonly inputFrames: { schedule(callback: () => void): () => void };
    readonly alwaysSnap?: () => boolean;
    readonly dynamicSize?: () => boolean;
    readonly wrapMode?: () => boolean;
    readonly cropFromHandle?: (id: NodeId, edge: { readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 }, pointer: { readonly pointerId: number; readonly x: number; readonly y: number }) => boolean;
    readonly mappings: MappingHistory;
    readonly sampleToSurface: (sample: RealSample) => Point;
    readonly clientToSurface: (x: number, y: number) => Point;
    readonly interaction: { invalidate(): void; cameraChanged(): void };
    readonly platform: () => { animateZoom(targetZ: number, anchor?: Point): void; animatePan(delta: Point, durationMs: number): void; glideTo(target: Camera, durationMs: number): void; startFling(samples: readonly TouchPanSample[]): void; cancelMotion(): void };
    readonly ui: {
        readonly mac: boolean;
        readonly text: BoardTextEditorOptions['ui'];
        readonly cards?: BoardCardActions | null;
        shortcutsEnabled(): boolean;
        modalOpen(): boolean;
        isDirectPen(event: PointerEvent): boolean;
        ownsWheel(event: WheelEvent): boolean;
        edgeScrolling(): boolean;
        mouseWheel(): boolean;
        invertMouseZoom(): boolean;
        error(error: unknown): void;
        notice?(message: string): void;
        contextMenu(request: BoardContextMenuRequest): void;
        persistToolLock?(locked: boolean): void;
        penModeChanged(enabled: boolean): void;
        pointerChanged?(sample: RealSample): void;
        hover?(event: PointerEvent): void;
        linkAt?(sample: RealSample): (() => void) | null;
        keyboardNavigation?: BoardInputServices['keyboardNavigation'];
        keyboardCursorInitial?: BoardInputServices['keyboardCursorInitial'];
        keyboardCursorVisible?: BoardInputServices['keyboardCursorVisible'];
        clearLatches?(): void;
        openKeyboardContextMenu?(request: KeyboardContextRequest): void;
    };
    readonly commands: BoardInputServices['commands'];
    readonly imports: {
        media(sample: RealSample, modifiers: Modifiers): PointerRoute<unknown>;
        drop(event: DragEvent): void;
        paste(event: ClipboardEvent): void;
        cancelPending(): boolean;
        landing(): Promise<void> | null;
        dispose(): void;
    };
}
const svgNS = 'http://www.w3.org/2000/svg';
function route<T>(tool: Tool<T>, context: T): PointerRoute<unknown> {
    return { tool: { id: tool.id, begin: (sample, modifiers) => tool.begin(sample, modifiers, context) }, context: undefined };
}

export function createBoardToolServices(options: BoardToolServicesOptions) {
    const { runtime, engine, camera, token, inputToken, ui } = options;
    if (engine.session !== runtime.session || !options.imports || typeof options.imports.media !== 'function'
        || typeof options.imports.paste !== 'function' || typeof options.imports.drop !== 'function'
        || typeof options.imports.cancelPending !== 'function' || typeof options.imports.landing !== 'function' || typeof options.imports.dispose !== 'function') throw new TypeError('Tool services require the canonical session and import backend');
    let disposed = false;
    const current = () => !disposed && options.visible() && options.current(token);
    const editable = () => current() && options.editable() && !runtime.session.isReadOnly;
    const point = createBoardPointQuery({ runtime, geometry: runtime.render, camera: options.view,
        fontEpoch: () => runtime.render.text.fonts.epoch, current, onError: ui.error });
    const region = createBoardRegionQuery({ runtime, geometry: runtime.render, camera: options.view,
        fontEpoch: () => runtime.render.text.fonts.epoch, current: t => current() && options.current(t), onError: ui.error });
    const preview = createBoardPreview({ runtime, engine, render: runtime.render, images: options.images, current, onError: ui.error,
        view: () => ({ camera: camera.camera, viewport: options.viewport() }) });
    preview.warm();
    const select = createBoardSelectServices({ runtime, render: runtime.render, camera: options.view, cameraController: camera,
        motion: { glideTo: (target, durationMs) => options.platform().glideTo(target, durationMs), cancel: () => options.platform().cancelMotion() },
        surface: options.surface, inputToken, cameraChanged: options.interaction.cameraChanged, sampleToSurface: options.sampleToSurface, point, region, preview,
        overlay: options.overlay, token, current: t => current() && options.current(t), canMutateView: () => options.editable() && !runtime.session.isReadOnly,
        inputFrames: options.inputFrames, alwaysSnap: options.alwaysSnap, wrapMode: options.wrapMode, cropFromHandle: options.cropFromHandle,
        editSticky: async id => { await text.editText(id); }, editTextAt: (id, point, pointerId, clicks) => text.editTextAt(id, point, pointerId, clicks), cards: ui.cards, onError: ui.error, openKeyboardContextMenu: ui.openKeyboardContextMenu,
        onKeptLocked: kept => ui.notice?.(keptLockedMessage(kept.length)) });
    const sensitive = createSensitiveTargets(() => { if (!disposed) options.interaction.invalidate(); });
    let hoverPick: AbortController | null = null, hoverSeq = 0;
    const endHoverPick = () => { hoverPick?.abort(); hoverPick = null; };
    const clearHover = () => { sensitive.setHovered(null); select.setHover(null); select.setConnectorHover(null, null, false); };
    let lastPointer: PointerEvent | null = null;
    const trackHover = (event: PointerEvent) => {
        lastPointer = event.type === 'pointerout' ? null : event;
        endHoverPick();
        const tool = runtime.tools.getSnapshot().active.id;
        const arrow = tool === 'connector';
        if (event.type === 'pointerout' || (tool !== 'select' && tool !== 'eraser' && !arrow) || !current()
            || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) { clearHover(); return; }
        const input = event.pointerType === 'pen' ? 'pen' : 'mouse';
        let at: Point;
        try { at = options.clientToSurface(event.clientX, event.clientY); } catch { clearHover(); return; }
        const controller = new AbortController(), seq = ++hoverSeq;
        hoverPick = controller;
        if (arrow) {
            if (event.ctrlKey || event.metaKey) { select.setConnectorHover(null, null, false); return; }
            const world = surfaceToWorld(at, camera.camera), exact = event.altKey, elbow = runtime.session.doc.ui.next.route === 'elbow';
            attachments.resolve(world, controller.signal, { precise: false, exact, route: 'arc', input }).then(attached => {
                if (!controller.signal.aborted && seq === hoverSeq) select.setConnectorHover(attached?.target ?? null, world, exact, elbow);
            }, () => { if (!controller.signal.aborted && seq === hoverSeq) select.setConnectorHover(null, null, false); });
            return;
        }
        point.hitHover(at, input, controller.signal).then(id => {
            if (!controller.signal.aborted && seq === hoverSeq) { sensitive.setHovered(id); if (tool === 'select') select.setHover(id); }
        }, () => { if (!controller.signal.aborted && seq === hoverSeq) { sensitive.setHovered(null); if (tool === 'select') select.setHover(null); } });
    };
    const stopHoverRepick = runtime.session.subscribe(() => {
        if (lastPointer && !runtime.session.isGestureActive && !disposed) trackHover(lastPointer);
    });
    const text = createBoardTextEditor({ runtime, render: runtime.render, engine, preview, point, camera, viewport: options.viewport,
        overlay: options.overlay, keyboardTarget: options.surface, current, interaction: options.interaction, inputFrames: options.inputFrames, mac: ui.mac,
        spelling: options.spelling, ui: ui.text, onError: ui.error, editingChanged: id => sensitive.setEditing(id) });
    const attachments = createBoardAttachmentResolver({ runtime, render: runtime.render, point, camera: options.view, current });
    const ink = createBoardInkServices({ runtime, samples: runtime.samples, token: inputToken, current: t => current()
        && t.vaultEpoch === inputToken.vaultEpoch && t.tabId === inputToken.tabId && t.sessionGeneration === inputToken.sessionGeneration
        && t.viewGeneration === inputToken.viewGeneration && editable(), style: () => runtime.session.doc.ui, camera,
        mappings: options.mappings, invalidate: options.interaction.invalidate, onError: ui.error });
    let creationTail: Promise<void> = Promise.resolve();
    const creationTurn = () => {
        const ready = creationTail;
        let done!: () => void;
        creationTail = new Promise<void>(resolve => { done = resolve; });
        return { ready, done };
    };
    const pending = new Set<() => void>();
    const registerPending = (cancel: () => void) => { if (!editable()) throw new DOMException('View is not editable', 'AbortError'); pending.add(cancel); return () => { pending.delete(cancel); }; };
    let brush: ZoomBox | null = null, column: { x: number; y: number; width: number | null } | null = null;
    let svg: SVGSVGElement | null = null, deadline: (() => void) | null = null;
    const invalidate = () => options.interaction.invalidate();
    const laserTrail = new LaserTrail(() => performance.now());
    let laserSheet: string | null = null;
    const ERASE_TRAIL_MS = 350;
    let erasePath: { x: number; y: number; time: number }[] = [];
    let eraseReach = 8;
    const scheduleTrails = () => {
        deadline?.(); deadline = null;
        if ((!laserTrail.active && erasePath.length < 2) || !current()) return;
        deadline = getPlatformRuntime().scheduler.scheduleDeadline(performance.now() + 32, () => { deadline = null; if (current()) invalidate(); });
    };
    const dropTrails = (): boolean => {
        const hadLaser = laserTrail.clear(), hadErase = erasePath.length > 0;
        erasePath = [];
        deadline?.(); deadline = null;
        if (hadLaser || hadErase) invalidate();
        return hadLaser;
    };
    const laserContext = {
        append(p: LaserPoint) { if (!current()) return; laserTrail.append(p); invalidate(); scheduleTrails(); },
        finish() { laserTrail.finish(); scheduleTrails(); },
        cancel() { laserTrail.cancel(); deadline?.(); deadline = null; invalidate(); },
    };
    const erasePoint = (p: { x: number; y: number; time: number }, radiusCss: number) => {
        if (!current()) return;
        eraseReach = radiusCss;
        erasePath.push({ x: p.x, y: p.y, time: p.time });
        if (erasePath.length > 512) erasePath.splice(0, erasePath.length - 512);
        invalidate(); scheduleTrails();
    };
    let overviewContent: { readonly rev: number; readonly box: ContentRect | null } | null = null;
    let overviewPending: { readonly rev: number; readonly controller: AbortController } | null = null;
    const prepareOverview = () => {
        const doc = runtime.session.doc, rev = doc.rev;
        if (overviewContent?.rev === rev || overviewPending?.rev === rev) return;
        overviewPending?.controller.abort();
        const controller = new AbortController(), pending = { rev, controller };
        overviewPending = pending;
        const roots = (doc.children.get(runtime.selection.getSnapshot().sheet) ?? []).map(child => child.id);
        const fence = () => { if (controller.signal.aborted || runtime.session.doc !== doc || doc.rev !== rev) throw new DOMException('Overview content changed', 'AbortError'); };
        void contentBounds(runtime, roots, { signal: controller.signal, fence, cooperate: yieldToHost })
            .then(box => { if (!controller.signal.aborted) overviewContent = { rev, box }; })
            .catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) ui.error(error); })
            .finally(() => { if (overviewPending === pending) overviewPending = null; });
    };
    const zoom: ZoomBrushContext = {
        toSurface: options.sampleToSurface,
        preview(box) { brush = box; invalidate(); },
        clearPreview() { brush = null; invalidate(); },
        fitBox(box, cap) {
            const vp = options.viewport(); if (box.width <= 0 || box.height <= 0 || vp.width <= 0 || vp.height <= 0) return;
            const world = surfaceToWorld({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, camera.camera);
            const fit = Math.min(vp.width / box.width, vp.height / box.height);
            const target = camera.clampZoom(camera.camera.z * (cap === undefined ? fit : Math.min(fit, cap)));
            const centre = { x: vp.width / 2, y: vp.height / 2 }, z = camera.camera.z;
            options.platform().cancelMotion(); camera.setCamera({ x: world.x - centre.x / z, y: world.y - centre.y / z, z });
            options.interaction.cameraChanged(); options.platform().animateZoom(target, centre);
        },
        stepZoom(direction, anchor) { options.platform().cancelMotion(); options.platform().animateZoom(camera.clampZoom(stepBoardZoom(runtime.session.doc, camera, direction)), anchor); },
        view: () => ({ camera: camera.camera, viewport: options.viewport() }),
        setCamera(next) { options.platform().cancelMotion(); camera.setCamera(next); options.interaction.cameraChanged(); },
        clampZoom: z => camera.clampZoom(z),
        prepareOverview,
        overviewBox: () => overviewContent && overviewContent.rev === runtime.session.doc.rev ? overviewContent.box : null,
    };
    const textContext = {
        createText(x: number, y: number, width: number | null, seed?: string) { if (editable()) text.manager.create(x, y, width, seed); },
        worldToScreen: (x: number, y: number) => worldToSurface({ x, y }, camera.camera),
        previewTextColumn(x: number, y: number, width: number | null) { column = { x, y, width }; invalidate(); },
        clearTextColumnPreview() { column = null; invalidate(); },
    };
    const creation = (choice: ToolChoice, sample: RealSample, follow: boolean): PointerRoute<unknown> => {
        const variant = choice.variant ?? runtime.tools.getSnapshot().lastFigure ?? 'rectangle';
        if (choice.id === 'figure' && !FIGURE_SHAPES.includes(variant as FigureShape)) throw new RangeError('Invalid figure variant');
        const kind = choice.id as 'figure' | 'sticky' | 'frame' | 'connector' | 'polyline';
        return { ...route(boardCreationTool(kind), { runtime, render: runtime.render, camera, kind, registerPending,
            settle: () => runtime.session.beginGesture('settling'), registerSettling: select.registerSettling, creationTurn,
            sampleToSurface: options.sampleToSurface, guides: select.setGuides, hint: select.setConnectorTarget, binding: select.setConnectorBinding, alwaysSnap: options.alwaysSnap, dynamicSize: options.dynamicSize,
            ...(kind === 'figure' ? { figure: variant as FigureShape } : {}), preview, current: editable, follow,
            editText: async id => { await text.editText(id); }, resolveAttachment: (position, signal, request) => attachments.resolve(position, signal,
                { ...request, input: sample.source === 'keyboard' ? 'mouse' : sample.source }), onError: ui.error }), completesTool: true };
    };
    const resolveChromeDrag = (choice: ToolChoice, sample: RealSample, _modifiers: Modifiers): PointerRoute<unknown> | null => {
        if (!editable()) return null;
        switch (choice.id) {
            case 'text': return route(textDropTool(choice.label), textContext);
            case 'figure': case 'sticky': case 'frame': case 'connector': case 'polyline': return creation(choice, sample, true);
            default: return null;
        }
    };
    const resolve = (choice: ToolChoice, sample: RealSample, modifiers: Modifiers): PointerRoute<unknown> | null => {
        if (!editable()) return null;
        switch (choice.id) {
            case 'select': return route(select.tool, undefined);
            case 'eraser': return route(eraserTool, { ...select.eraser, trail: erasePoint });
            case 'laser': return route(laserTool, laserContext);
            case 'zoom': return route(zoomBrushTool, zoom);
            case 'text': return route(textTool, textContext);
            case 'media': {
                const media = options.imports.media(sample, modifiers);
                if (!media?.tool || typeof media.tool.begin !== 'function') throw new Error('Media import backend did not supply a tool');
                return media;
            }
            case 'figure': case 'sticky': case 'frame': case 'connector': case 'polyline': return creation(choice, sample, false);
            default: throw new Error(`Unsupported routed board tool: ${choice.id}`);
        }
    };
    const cancelPending = () => {
        const selectionCancelled = select.cancelPending(), textCancelled = text.cancelPending();
        let cancelled = selectionCancelled || textCancelled;
        for (const cancel of [...pending]) { pending.delete(cancel); try { cancel(); } catch (error) { ui.error(error); } cancelled = true; }
        try { if (options.imports.cancelPending()) cancelled = true; } catch (error) { ui.error(error); }
        if (!text.manager.current) preview.clear();
        brush = null; column = null; laserContext.cancel(); erasePath = []; return cancelled;
    };
    const paste = (event: ClipboardEvent) => {
        if (!event.defaultPrevented && editable() && options.focused() && !ui.modalOpen() && !text.manager.current) options.imports.paste(event);
    };
    options.surface.addEventListener('paste', paste);
    const contextMenuAt = (event: MouseEvent) => {
        event.preventDefault();
        const opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement;
        const point = { x: event.clientX, y: event.clientY };
        const open = (locked: NodeId | null) => { if (opener instanceof HTMLElement) ui.contextMenu({ point, opener, locked }); };
        let world: Point;
        try { world = surfaceToWorld(options.clientToSurface(point.x, point.y), options.view().camera); } catch (error) { ui.error(error); open(null); return; }
        const signal = new AbortController().signal;
        void select.lockedAt(world, signal).then(async locked => {
            if (locked === null) {
                try { await select.secondarySelect(world, signal); }
                catch (error) { if (!isCancellation(error)) ui.error(error); }
            }
            open(locked);
        }, error => {
            if (!isCancellation(error)) ui.error(error);
            open(null);
        });
    };
    const services: BoardInputServices = {
        tools: runtime.tools, history: runtime.session.history, mac: ui.mac, shortcutsEnabled: ui.shortcutsEnabled, modalOpen: ui.modalOpen,
        edgeScrolling: ui.edgeScrolling, mouseWheel: ui.mouseWheel, invertMouseZoom: ui.invertMouseZoom,
        animateZoom: (zoom, anchor) => { options.platform().cancelMotion(); options.platform().animateZoom(camera.clampZoom(zoom), anchor); },
        startFling: samples => options.platform().startFling(samples),
        cancelMotion: () => options.platform().cancelMotion(),
        editing: () => !!text.manager.current, textInput: text.input, isDirectPen: ui.isDirectPen,
        handleDoubleClick: (surface, world, time) => select.doubleClickHandle(surface, world, time),
        commands: { run: (id, event) => {
            if (select.command(id)) return true;
            if ((id === 'preferences.grid' || id === 'preferences.focus') && !editable()) return true;
            return options.commands.run(id, event);
        } },
        ink: ink.ink, continueInk: ink.continueInk,
        resolveTool: (choice, sample, modifiers) => resolve(choice, sample, modifiers),
        resolveKeyboardTool: (choice, sample, modifiers) => resolve(choice, sample, modifiers), resolveChromeDrag, zoomBrush: () => zoom,
        keyboardCursorInitial: ui.keyboardCursorInitial, keyboardCursorVisible: ui.keyboardCursorVisible, keyboardNavigation: ui.keyboardNavigation,
        ownsWheel: ui.ownsWheel, cameraChanged: options.interaction.cameraChanged, error: ui.error,
        pointerChanged: sample => { notePointerSource(sample.source); ui.pointerChanged?.(sample); }, keyEditLanding: select.keyEditLanding,
        pasteLanding: () => options.imports.landing(),
        hover: event => { ui.hover?.(event); trackHover(event); }, contextMenu: contextMenuAt, drop: event => options.imports.drop(event), linkAt: ui.linkAt,
        penModeChanged: ui.penModeChanged, persistToolLock: ui.persistToolLock, clearLatches: ui.clearLatches, cancelPendingGestures: cancelPending,
        clearLaserTrail: dropTrails,
        undoSettlingGestures: () => select.cancelSettling(true),
        keyboardContextMenu: select.keyboardContextMenu,
    };
    const writeOverlays = (frame: ScheduledFrame) => {
        if (!current() || frame.token.vaultEpoch !== token.vaultEpoch || frame.token.documentId !== token.documentId
            || frame.token.bytesGeneration !== token.bytesGeneration || frame.token.session !== token.session) return;
        select.writeOverlays(frame); text.writeOverlays(frame);
        const sheet = runtime.selection.getSnapshot().sheet;
        if (sheet !== laserSheet) { laserSheet = sheet; laserTrail.clear(); }
        const laserStrokes = laserTrail.frame(frame.timestamp);
        erasePath = erasePath.filter(p => frame.timestamp - p.time < ERASE_TRAIL_MS);
        if (!laserStrokes.length && erasePath.length < 2 && !brush && !column) { svg?.remove(); svg = null; deadline?.(); deadline = null; return; }
        if (!svg) { svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg); }
        svg.setAttribute('viewBox', `0 0 ${frame.view.viewport.width} ${frame.view.viewport.height}`); svg.replaceChildren();
        for (const stroke of laserStrokes) {
            if (stroke.points.length === 1) {
                const p = worldToSurface(stroke.points[0], frame.view.camera), dot = document.createElementNS(svgNS, 'circle');
                dot.setAttribute('cx', String(p.x)); dot.setAttribute('cy', String(p.y)); dot.setAttribute('r', '2');
                dot.setAttribute('fill', '#ff4040'); dot.setAttribute('opacity', '0.7'); svg.append(dot);
                continue;
            }
            let d = '';
            stroke.points.forEach((point, i) => { const p = worldToSurface(point, frame.view.camera); d += `${i ? 'L' : 'M'}${p.x} ${p.y}`; });
            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#ff4040');
            path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); path.setAttribute('stroke-width', '4');
            path.setAttribute('opacity', '0.7'); svg.append(path);
        }
        if (erasePath.length > 1) {
            let d = '';
            erasePath.forEach((point, i) => { const p = worldToSurface(point, frame.view.camera); d += `${i ? 'L' : 'M'}${p.x} ${p.y}`; });
            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('stroke-width', String(eraseReach * 2)); path.style.stroke = 'var(--text-muted)'; path.setAttribute('opacity', '0.35'); svg.append(path);
        }
        if (brush || column) {
            const box = brush ?? (() => { const p = worldToSurface(column!, frame.view.camera); return { x: p.x,
                y: column!.width === null ? p.y - 11 : p.y, width: (column!.width ?? 1 / frame.view.camera.z) * frame.view.camera.z, height: 22 }; })();
            const rect = document.createElementNS(svgNS, 'rect');
            rect.setAttribute('x', String(box.x)); rect.setAttribute('y', String(box.y)); rect.setAttribute('width', String(box.width)); rect.setAttribute('height', String(box.height));
            rect.setAttribute('fill', 'rgba(80,145,255,0.12)'); rect.setAttribute('stroke', '#6a9fff'); rect.setAttribute('stroke-width', '1.5'); svg.append(rect);
        }
        scheduleTrails();
    };
    const dispose = () => {
        if (disposed) return; cancelPending(); disposed = true; endHoverPick(); stopHoverRepick(); options.surface.removeEventListener('paste', paste);
        deadline?.(); deadline = null; svg?.remove(); svg = null;
        for (const cleanup of [text.dispose, select.dispose, point.dispose, preview.dispose, options.imports.dispose]) {
            try { cleanup(); } catch (error) { ui.error(error); }
        }
    };
    return { services, writeOverlays, finishComposition: text.finishComposition, captureText: text.captureText,
        // A committed preview holds a gesture until its revision is presented; without this the hold never
        // ended and every later drag on the board was refused (seen: resize/rotate dead after one move).
        presented: (revision: number, token: RenderToken, frame?: PaintSource) => preview.presented(revision, token, frame),
        restoreText: text.restoreText, beforeHistoryReplay: text.beforeHistoryReplay, cancelPending, dispose,
        sensitiveNodeIds: () => sensitive.ids(),
        actualsubcontrollers: { ink, point, region, preview, select, text, attachments } };
}
