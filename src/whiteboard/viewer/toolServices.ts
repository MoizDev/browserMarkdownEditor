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

/** The board's context-menu request: the pointer, the element the menu hangs from, and the locked node it targets, if any. */
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
    /** The board's always-snap preference, read live on each gesture; absent means no always-snap. */
    readonly alwaysSnap?: () => boolean;
    /** Dynamic size mode: new text and notes are created at 1 / zoom. */
    readonly dynamicSize?: () => boolean;
    /** The board's wrap-mode preference, read live on each gesture (brush selects only what it fully encloses). */
    readonly wrapMode?: () => boolean;
    readonly mappings: MappingHistory;
    readonly sampleToSurface: (sample: RealSample) => Point;
    readonly clientToSurface: (x: number, y: number) => Point;
    readonly interaction: { invalidate(): void; cameraChanged(): void };
    readonly platform: () => { animateZoom(targetZ: number, anchor?: Point): void; animatePan(delta: Point): void; glideTo(target: Camera, durationMs: number): void; startFling(samples: readonly TouchPanSample[]): void; cancelMotion(): void };
    readonly ui: {
        readonly mac: boolean;
        readonly text: BoardTextEditorOptions['ui'];
        /** The embed and link-card chips' actions; the native canvas supplies them, a view without an embed host omits them. */
        readonly cards?: BoardCardActions | null;
        shortcutsEnabled(): boolean;
        modalOpen(): boolean;
        isDirectPen(event: PointerEvent): boolean;
        ownsWheel(event: WheelEvent): boolean;
        /** Preferences: the Edge scrolling preference, the Input device choice, and whether the mouse wheel's zoom turn is inverted. */
        edgeScrolling(): boolean;
        mouseWheel(): boolean;
        invertMouseZoom(): boolean;
        error(error: unknown): void;
        /** A quiet status message for the board's own surface (R-11 kept-locked notice). */
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
        /** The host's one existing board context menu, opened at an actual keyboard anchor. Absent means no keyboard menu. */
        openKeyboardContextMenu?(request: KeyboardContextRequest): void;
    };
    readonly commands: BoardInputServices['commands'];
    /** The App supplies real permission-aware import and clipboard backends. */
    readonly imports: {
        media(sample: RealSample, modifiers: Modifiers): PointerRoute<unknown>;
        drop(event: DragEvent): void;
        paste(event: ClipboardEvent): void;
        cancelPending(): boolean;
        dispose(): void;
    };
}
const svgNS = 'http://www.w3.org/2000/svg';
function route<T>(tool: Tool<T>, context: T): PointerRoute<unknown> {
    return { tool: { id: tool.id, begin: (sample, modifiers) => tool.begin(sample, modifiers, context) }, context: undefined };
}

/** View-owned routing only: history, tools, samples and document remain session-owned. */
export function createBoardToolServices(options: BoardToolServicesOptions) {
    const { runtime, engine, camera, token, inputToken, ui } = options;
    if (engine.session !== runtime.session || !options.imports || typeof options.imports.media !== 'function'
        || typeof options.imports.paste !== 'function' || typeof options.imports.drop !== 'function'
        || typeof options.imports.cancelPending !== 'function' || typeof options.imports.dispose !== 'function') throw new TypeError('Tool services require the canonical session and import backend');
    let disposed = false;
    const current = () => !disposed && options.visible() && options.current(token);
    const editable = () => current() && options.editable() && !runtime.session.isReadOnly;
    const point = createBoardPointQuery({ runtime, geometry: runtime.render, camera: options.view,
        fontEpoch: () => runtime.render.text.fonts.epoch, current, onError: ui.error });
    const region = createBoardRegionQuery({ runtime, geometry: runtime.render, camera: options.view,
        fontEpoch: () => runtime.render.text.fonts.epoch, current: t => current() && options.current(t), onError: ui.error });
    const preview = createBoardPreview({ runtime, engine, render: runtime.render, images: options.images, current, onError: ui.error,
        view: () => ({ camera: camera.camera, viewport: options.viewport() }) });
    // Editing activation: the overlay's kits compile now, not at the first drag's request.
    preview.warm();
    const select = createBoardSelectServices({ runtime, render: runtime.render, camera: options.view, cameraController: camera,
        motion: { glideTo: (target, durationMs) => options.platform().glideTo(target, durationMs), cancel: () => options.platform().cancelMotion() },
        surface: options.surface, inputToken, cameraChanged: options.interaction.cameraChanged, sampleToSurface: options.sampleToSurface, point, region, preview,
        overlay: options.overlay, token, current: t => current() && options.current(t), canMutateView: () => options.editable() && !runtime.session.isReadOnly,
        inputFrames: options.inputFrames, alwaysSnap: options.alwaysSnap, wrapMode: options.wrapMode,
        editSticky: async id => { await text.editText(id); }, cards: ui.cards, onError: ui.error, openKeyboardContextMenu: ui.openKeyboardContextMenu,
        onKeptLocked: kept => ui.notice?.(keptLockedMessage(kept.length)) });
    // Hover and edit targets from real callbacks: the text editor reports the node it holds, and the
    // pointer's hover is hit-tested by the same point query the select tool uses. Changes invalidate the view.
    const sensitive = createSensitiveTargets(() => { if (!disposed) options.interaction.invalidate(); });
    let hoverPick: AbortController | null = null, hoverSeq = 0;
    const endHoverPick = () => { hoverPick?.abort(); hoverPick = null; };
    const trackHover = (event: PointerEvent) => {
        endHoverPick();
        const tool = runtime.tools.getSnapshot().active.id;
        if (event.type === 'pointerout' || (tool !== 'select' && tool !== 'eraser') || !current()
            || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) { sensitive.setHovered(null); select.setHover(null); return; }
        const input = event.pointerType === 'pen' ? 'pen' : 'mouse';
        let at: Point;
        try { at = options.clientToSurface(event.clientX, event.clientY); } catch { sensitive.setHovered(null); select.setHover(null); return; }
        const controller = new AbortController(), seq = ++hoverSeq;
        hoverPick = controller;
        point.hit(at, input, controller.signal).then(id => {
            if (!controller.signal.aborted && seq === hoverSeq) { sensitive.setHovered(id); if (tool === 'select') select.setHover(id); }
        }, error => { if (!controller.signal.aborted) ui.error(error); });
    };
    const text = createBoardTextEditor({ runtime, render: runtime.render, engine, preview, point, camera, viewport: options.viewport,
        overlay: options.overlay, keyboardTarget: options.surface, current, interaction: options.interaction, inputFrames: options.inputFrames, mac: ui.mac,
        spelling: options.spelling, ui: ui.text, onError: ui.error, editingChanged: id => sensitive.setEditing(id) });
    const attachments = createBoardAttachmentResolver({ runtime, render: runtime.render, point, camera: options.view, current });
    const ink = createBoardInkServices({ runtime, samples: runtime.samples, token: inputToken, current: t => current()
        && t.vaultEpoch === inputToken.vaultEpoch && t.tabId === inputToken.tabId && t.sessionGeneration === inputToken.sessionGeneration
        && t.viewGeneration === inputToken.viewGeneration && editable(), style: () => runtime.session.doc.ui, camera,
        mappings: options.mappings, invalidate: options.interaction.invalidate, onError: ui.error });
    const pending = new Set<() => void>();
    const registerPending = (cancel: () => void) => { if (!editable()) throw new DOMException('View is not editable', 'AbortError'); pending.add(cancel); return () => { pending.delete(cancel); }; };
    let brush: ZoomBox | null = null, column: { x: number; y: number; width: number | null } | null = null;
    let svg: SVGSVGElement | null = null, deadline: (() => void) | null = null;
    const invalidate = () => options.interaction.invalidate();
    const laserTrail = new LaserTrail(() => performance.now());
    let laserSheet: string | null = null;
    // The eraser's path while it erases. A pointer that stops consumes its trail from the oldest end over ERASE_TRAIL_MS.
    const ERASE_TRAIL_MS = 350;
    let erasePath: { x: number; y: number; time: number }[] = [];
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
    const erasePoint = (p: { x: number; y: number; time: number }) => {
        if (!current()) return;
        erasePath.push({ x: p.x, y: p.y, time: p.time });
        if (erasePath.length > 512) erasePath.splice(0, erasePath.length - 512);
        invalidate(); scheduleTrails();
    };
    // The quick overview fits the sheet's content, which contentBounds reads asynchronously. Z's press reads it ahead, and it is kept
    // per document revision: a stale box is not used, so Shift never waits on the read and fits the viewport alone instead.
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
        void contentBounds(runtime, roots, { signal: controller.signal, fence, cooperate: () => new Promise<void>(resolve => setTimeout(resolve, 0)) })
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
        createText(x: number, y: number, width: number | null) { if (editable()) text.manager.create(x, y, width); },
        worldToScreen: (x: number, y: number) => worldToSurface({ x, y }, camera.camera),
        previewTextColumn(x: number, y: number, width: number | null) { column = { x, y, width }; invalidate(); },
        clearTextColumnPreview() { column = null; invalidate(); },
    };
    // A creation's route. A toolbar drag (`follow`) centres the shape on the pointer and moves it with the pointer until release.
    const creation = (choice: ToolChoice, sample: RealSample, follow: boolean): PointerRoute<unknown> => {
        const variant = choice.variant ?? runtime.tools.getSnapshot().lastFigure ?? 'rectangle';
        if (choice.id === 'figure' && !FIGURE_SHAPES.includes(variant as FigureShape)) throw new RangeError('Invalid figure variant');
        const kind = choice.id as 'figure' | 'sticky' | 'frame' | 'connector' | 'polyline';
        return { ...route(boardCreationTool(kind), { runtime, render: runtime.render, camera, kind, registerPending,
            sampleToSurface: options.sampleToSurface, guides: select.setGuides, hint: select.setConnectorTarget, alwaysSnap: options.alwaysSnap, dynamicSize: options.dynamicSize,
            ...(kind === 'figure' ? { figure: variant as FigureShape } : {}), preview, current: editable, follow,
            editText: async id => { await text.editText(id); }, resolveAttachment: (position, signal, request) => attachments.resolve(position, signal,
                { ...request, input: sample.source === 'keyboard' ? 'mouse' : sample.source }), onError: ui.error }), completesTool: true };
    };
    // A bar tool pressed on the chrome and dragged onto the board. Tools without a toolbar drag return null: the press is then a click.
    const resolveChromeDrag = (choice: ToolChoice, sample: RealSample, _modifiers: Modifiers): PointerRoute<unknown> | null => {
        if (!editable()) return null;
        switch (choice.id) {
            case 'text': return route(textDropTool, textContext);
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
    // A secondary click on a locked node targets it for the context menu without selecting it (F-CTX-006). The hit is
    // asynchronous, so the pointer and opener are read from the event now, before the browser releases it.
    const contextMenuAt = (event: MouseEvent) => {
        event.preventDefault();
        const opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement;
        const point = { x: event.clientX, y: event.clientY };
        const open = (locked: NodeId | null) => { if (opener instanceof HTMLElement) ui.contextMenu({ point, opener, locked }); };
        let world: Point;
        try { world = surfaceToWorld(options.clientToSurface(point.x, point.y), options.view().camera); } catch (error) { ui.error(error); open(null); return; }
        const signal = new AbortController().signal;
        // A locked node is targeted without being selected (F-CTX-006); any other press first selects what it lands on.
        void select.lockedAt(world, signal).then(async locked => {
            if (locked === null) {
                try { await select.secondarySelect(world, signal); }
                catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) ui.error(error); }
            }
            open(locked);
        }, error => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) ui.error(error);
            open(null);
        });
    };
    const services: BoardInputServices = {
        tools: runtime.tools, history: runtime.session.history, mac: ui.mac, shortcutsEnabled: ui.shortcutsEnabled, modalOpen: ui.modalOpen,
        edgeScrolling: ui.edgeScrolling, mouseWheel: ui.mouseWheel, invertMouseZoom: ui.invertMouseZoom,
        animateZoom: (zoom, anchor) => { options.platform().cancelMotion(); options.platform().animateZoom(camera.clampZoom(zoom), anchor); },
        // A pan's release slides the view; a new press stops whatever motion is still running (both were unwired before).
        startFling: samples => options.platform().startFling(samples),
        cancelMotion: () => options.platform().cancelMotion(),
        editing: () => !!text.manager.current, textInput: text.input, isDirectPen: ui.isDirectPen,
        handleDoubleClick: (surface, world, time) => select.doubleClickHandle(surface, world, time),
        commands: { run: (id, event) => {
            if (select.command(id)) return true;
            // grid and focus are document state: a non-editable view consumes them rather than letting the host's global route promote them.
            if ((id === 'preferences.grid' || id === 'preferences.focus') && !editable()) return true;
            return options.commands.run(id, event);
        } },
        ink: ink.ink, continueInk: ink.continueInk,
        resolveTool: (choice, sample, modifiers) => resolve(choice, sample, modifiers),
        resolveKeyboardTool: (choice, sample, modifiers) => resolve(choice, sample, modifiers), resolveChromeDrag, zoomBrush: () => zoom,
        keyboardCursorInitial: ui.keyboardCursorInitial, keyboardCursorVisible: ui.keyboardCursorVisible, keyboardNavigation: ui.keyboardNavigation,
        ownsWheel: ui.ownsWheel, cameraChanged: options.interaction.cameraChanged, error: ui.error,
        pointerChanged: sample => { notePointerSource(sample.source); ui.pointerChanged?.(sample); },
        hover: event => { ui.hover?.(event); trackHover(event); }, contextMenu: contextMenuAt, drop: event => options.imports.drop(event), linkAt: ui.linkAt,
        penModeChanged: ui.penModeChanged, persistToolLock: ui.persistToolLock, clearLatches: ui.clearLatches, cancelPendingGestures: cancelPending,
        clearLaserTrail: dropTrails,
        keyboardContextMenu: select.keyboardContextMenu,
    };
    const writeOverlays = (frame: ScheduledFrame) => {
        if (!current() || frame.token.vaultEpoch !== token.vaultEpoch || frame.token.documentId !== token.documentId
            || frame.token.bytesGeneration !== token.bytesGeneration || frame.token.session !== token.session) return;
        select.writeOverlays(frame); text.writeOverlays(frame);
        // A laser trail belongs to the page it was drawn on: a page switch drops every session.
        const sheet = runtime.selection.getSnapshot().sheet;
        if (sheet !== laserSheet) { laserSheet = sheet; laserTrail.clear(); }
        const laserStrokes = laserTrail.frame(frame.timestamp);
        erasePath = erasePath.filter(p => frame.timestamp - p.time < ERASE_TRAIL_MS);
        if (!laserStrokes.length && erasePath.length < 2 && !brush && !column) { svg?.remove(); svg = null; deadline?.(); deadline = null; return; }
        if (!svg) { svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg); }
        svg.setAttribute('viewBox', `0 0 ${frame.view.viewport.width} ${frame.view.viewport.height}`); svg.replaceChildren();
        // Each laser stroke is one element at 0.7 opacity, so an overlap inside one stroke is not drawn darker.
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
            path.setAttribute('stroke-width', '12'); path.style.stroke = 'var(--text-muted)'; path.setAttribute('opacity', '0.5'); svg.append(path);
        }
        if (brush || column) {
            const box = brush ?? (() => { const p = worldToSurface(column!, frame.view.camera); return { x: p.x, y: p.y,
                width: (column!.width ?? 1 / frame.view.camera.z) * frame.view.camera.z, height: 22 }; })();
            const rect = document.createElementNS(svgNS, 'rect');
            rect.setAttribute('x', String(box.x)); rect.setAttribute('y', String(box.y)); rect.setAttribute('width', String(box.width)); rect.setAttribute('height', String(box.height));
            rect.setAttribute('fill', 'rgba(80,145,255,0.12)'); rect.setAttribute('stroke', '#6a9fff'); rect.setAttribute('stroke-width', '1.5'); svg.append(rect);
        }
        scheduleTrails();
    };
    const dispose = () => {
        if (disposed) return; cancelPending(); disposed = true; endHoverPick(); options.surface.removeEventListener('paste', paste);
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
