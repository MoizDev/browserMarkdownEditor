import { surfaceToWorld, worldToSurface, type CameraController, type Point } from '../../platform/render/camera';
import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { RenderToken } from '../../platform/render/types';
import type { PaintSource } from '../render/paintStream';
import { keptLockedMessage } from '../commands/delete';
import type { ViewState, Viewport } from '../../platform/types';
import type { BoardRuntime } from '../host/runtime';
import type { BoardInputServices } from '../input/attach';
import { eraserTool, laserTool, type LaserPoint } from '../input/basicTools';
import type { ToolChoice } from '../input/gesture';
import type { MappingHistory } from '../input/pointer';
import type { PointerRoute } from '../input/pointerRouter';
import type { InputToken, Modifiers, RealSample, Tool } from '../input/tool';
import type { ZoomBox, ZoomBrushContext } from '../input/zoomBrush';
import { zoomBrushTool } from '../input/zoomBrush';
import { FIGURE_SHAPES, type FigureShape } from '../model/styles';
import type { PaintImageProvider } from '../render/resources';
import { textTool } from '../text/edit/tool';
import { createBoardAttachmentResolver } from './attachments';
import { boardCreationTool } from './creationTools';
import { createBoardInkServices } from './inkServices';
import type { KeyboardContextRequest } from './keyboardContext';
import { createBoardPointQuery } from './pointQuery';
import { createBoardPreview } from './preview';
import { createBoardRegionQuery } from './regionQuery';
import { createBoardSelectServices } from './selectServices';
import { createBoardTextEditor, type BoardTextEditorOptions } from './textEditor';
import { createSensitiveTargets } from './sensitiveTargets';
import type { ViewerEngine } from './types';

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
    readonly mappings: MappingHistory;
    readonly sampleToSurface: (sample: RealSample) => Point;
    readonly clientToSurface: (x: number, y: number) => Point;
    readonly interaction: { invalidate(): void; cameraChanged(): void };
    readonly platform: () => { animateZoom(targetZ: number, anchor?: Point): void; cancelMotion(): void };
    readonly ui: {
        readonly mac: boolean;
        readonly text: BoardTextEditorOptions['ui'];
        shortcutsEnabled(): boolean;
        modalOpen(): boolean;
        isDirectPen(event: PointerEvent): boolean;
        ownsWheel(event: WheelEvent): boolean;
        error(error: unknown): void;
        /** A quiet status message for the board's own surface (R-11 kept-locked notice). */
        notice?(message: string): void;
        contextMenu(event: MouseEvent): void;
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
    const preview = createBoardPreview({ runtime, engine, render: runtime.render, images: options.images, current, onError: ui.error });
    const select = createBoardSelectServices({ runtime, render: runtime.render, camera: options.view, cameraController: camera,
        surface: options.surface, inputToken, cameraChanged: options.interaction.cameraChanged, sampleToSurface: options.sampleToSurface, point, region, preview,
        overlay: options.overlay, token, current: t => current() && options.current(t), canMutateView: () => options.editable() && !runtime.session.isReadOnly,
        inputFrames: options.inputFrames, alwaysSnap: options.alwaysSnap,
        editSticky: async id => { await text.editText(id); }, onError: ui.error, openKeyboardContextMenu: ui.openKeyboardContextMenu,
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
            || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) { sensitive.setHovered(null); return; }
        const input = event.pointerType === 'pen' ? 'pen' : 'mouse';
        let at: Point;
        try { at = options.clientToSurface(event.clientX, event.clientY); } catch { sensitive.setHovered(null); return; }
        const controller = new AbortController(), seq = ++hoverSeq;
        hoverPick = controller;
        point.hit(at, input, controller.signal).then(id => {
            if (!controller.signal.aborted && seq === hoverSeq) sensitive.setHovered(id);
        }, error => { if (!controller.signal.aborted) ui.error(error); });
    };
    const text = createBoardTextEditor({ runtime, render: runtime.render, engine, preview, point, camera, viewport: options.viewport,
        overlay: options.overlay, current, interaction: options.interaction, inputFrames: options.inputFrames, mac: ui.mac,
        spelling: options.spelling, ui: ui.text, onError: ui.error, editingChanged: id => sensitive.setEditing(id) });
    const attachments = createBoardAttachmentResolver({ runtime, render: runtime.render, point, camera: options.view, current });
    const ink = createBoardInkServices({ runtime, samples: runtime.samples, token: inputToken, current: t => current()
        && t.vaultEpoch === inputToken.vaultEpoch && t.tabId === inputToken.tabId && t.sessionGeneration === inputToken.sessionGeneration
        && t.viewGeneration === inputToken.viewGeneration && editable(), style: () => runtime.session.doc.ui, camera,
        mappings: options.mappings, invalidate: options.interaction.invalidate, onError: ui.error });
    const pending = new Set<() => void>();
    const registerPending = (cancel: () => void) => { if (!editable()) throw new DOMException('View is not editable', 'AbortError'); pending.add(cancel); return () => { pending.delete(cancel); }; };
    let brush: ZoomBox | null = null, column: { x: number; y: number; width: number | null } | null = null;
    let svg: SVGSVGElement | null = null, laser: LaserPoint[] = [], laserActive = false, deadline: (() => void) | null = null;
    const invalidate = () => options.interaction.invalidate();
    const scheduleLaser = () => {
        deadline?.(); deadline = null;
        if (!laser.length || !current()) return;
        deadline = getPlatformRuntime().scheduler.scheduleDeadline(performance.now() + 32, () => { deadline = null; if (current()) invalidate(); });
    };
    const laserContext = {
        append(p: LaserPoint) { if (!current()) return; if (!laserActive) { laser = []; laserActive = true; }
            laser.push({ ...p }); if (laser.length > 512) laser.splice(0, laser.length - 512); invalidate(); scheduleLaser(); },
        finish() { laserActive = false; scheduleLaser(); },
        cancel() { laserActive = false; laser = []; deadline?.(); deadline = null; invalidate(); },
    };
    const zoom: ZoomBrushContext = {
        toSurface: options.sampleToSurface,
        preview(box) { brush = box; invalidate(); },
        clearPreview() { brush = null; invalidate(); },
        fitBox(box) {
            const vp = options.viewport(); if (box.width <= 0 || box.height <= 0 || vp.width <= 0 || vp.height <= 0) return;
            const world = surfaceToWorld({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, camera.camera);
            const target = camera.clampZoom(camera.camera.z * Math.min(vp.width / box.width, vp.height / box.height));
            const centre = { x: vp.width / 2, y: vp.height / 2 }, z = camera.camera.z;
            options.platform().cancelMotion(); camera.setCamera({ x: world.x - centre.x / z, y: world.y - centre.y / z, z });
            options.interaction.cameraChanged(); options.platform().animateZoom(target, centre);
        },
        zoomAt(anchor, factor) { options.platform().cancelMotion(); options.platform().animateZoom(camera.clampZoom(camera.camera.z * factor), anchor); },
    };
    const textContext = {
        createText(x: number, y: number, width: number | null) { if (editable()) text.manager.create(x, y, width); },
        worldToScreen: (x: number, y: number) => worldToSurface({ x, y }, camera.camera),
        previewTextColumn(x: number, y: number, width: number | null) { column = { x, y, width }; invalidate(); },
        clearTextColumnPreview() { column = null; invalidate(); },
    };
    const resolve = (choice: ToolChoice, sample: RealSample, modifiers: Modifiers): PointerRoute<unknown> | null => {
        if (!editable()) return null;
        switch (choice.id) {
            case 'select': return route(select.tool, undefined);
            case 'eraser': return route(eraserTool, select.eraser);
            case 'laser': return route(laserTool, laserContext);
            case 'zoom': return route(zoomBrushTool, zoom);
            case 'text': return route(textTool, textContext);
            case 'media': {
                const media = options.imports.media(sample, modifiers);
                if (!media?.tool || typeof media.tool.begin !== 'function') throw new Error('Media import backend did not supply a tool');
                return media;
            }
            case 'figure': case 'sticky': case 'frame': case 'connector': case 'polyline': {
                const variant = choice.variant ?? runtime.tools.getSnapshot().lastFigure ?? 'rectangle';
                if (choice.id === 'figure' && !FIGURE_SHAPES.includes(variant as FigureShape)) throw new RangeError('Invalid figure variant');
                const kind = choice.id;
                return { ...route(boardCreationTool(kind), { runtime, render: runtime.render, camera, kind, registerPending,
                    sampleToSurface: options.sampleToSurface, guides: select.setGuides, alwaysSnap: options.alwaysSnap,
                    ...(kind === 'figure' ? { figure: variant as FigureShape } : {}), preview, current: editable,
                    editText: async id => { await text.editText(id); }, resolveAttachment: (position, signal, request) => attachments.resolve(position, signal,
                        { ...request, input: sample.source === 'keyboard' ? 'mouse' : sample.source }), onError: ui.error }), completesTool: true };
            }
            default: throw new Error(`Unsupported routed board tool: ${choice.id}`);
        }
    };
    const cancelPending = () => {
        const selectionCancelled = select.cancelPending(), textCancelled = text.cancelPending();
        let cancelled = selectionCancelled || textCancelled;
        for (const cancel of [...pending]) { pending.delete(cancel); try { cancel(); } catch (error) { ui.error(error); } cancelled = true; }
        try { if (options.imports.cancelPending()) cancelled = true; } catch (error) { ui.error(error); }
        if (!text.manager.current) preview.clear();
        brush = null; column = null; laserContext.cancel(); return cancelled;
    };
    const paste = (event: ClipboardEvent) => {
        if (!event.defaultPrevented && editable() && options.focused() && !ui.modalOpen() && !text.manager.current) options.imports.paste(event);
    };
    options.surface.addEventListener('paste', paste);
    const services: BoardInputServices = {
        tools: runtime.tools, history: runtime.session.history, mac: ui.mac, shortcutsEnabled: ui.shortcutsEnabled, modalOpen: ui.modalOpen,
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
        resolveKeyboardTool: (choice, sample, modifiers) => resolve(choice, sample, modifiers), zoomBrush: () => zoom,
        keyboardCursorInitial: ui.keyboardCursorInitial, keyboardCursorVisible: ui.keyboardCursorVisible, keyboardNavigation: ui.keyboardNavigation,
        ownsWheel: ui.ownsWheel, cameraChanged: options.interaction.cameraChanged, error: ui.error, pointerChanged: ui.pointerChanged,
        hover: event => { ui.hover?.(event); trackHover(event); }, contextMenu: ui.contextMenu, drop: event => options.imports.drop(event), linkAt: ui.linkAt,
        penModeChanged: ui.penModeChanged, persistToolLock: ui.persistToolLock, clearLatches: ui.clearLatches, cancelPendingGestures: cancelPending,
        keyboardContextMenu: select.keyboardContextMenu,
    };
    const writeOverlays = (frame: ScheduledFrame) => {
        if (!current() || frame.token.vaultEpoch !== token.vaultEpoch || frame.token.documentId !== token.documentId
            || frame.token.bytesGeneration !== token.bytesGeneration || frame.token.session !== token.session) return;
        select.writeOverlays(frame); text.writeOverlays(frame);
        laser = laser.filter(p => frame.timestamp - p.time < 800);
        if (!laser.length && !brush && !column) { svg?.remove(); svg = null; deadline?.(); deadline = null; return; }
        if (!svg) { svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg); }
        svg.setAttribute('viewBox', `0 0 ${frame.view.viewport.width} ${frame.view.viewport.height}`); svg.replaceChildren();
        if (laser.length === 1) {
            const p = worldToSurface(laser[0], frame.view.camera), dot = document.createElementNS(svgNS, 'circle');
            dot.setAttribute('cx', String(p.x)); dot.setAttribute('cy', String(p.y)); dot.setAttribute('r', '1.5');
            dot.setAttribute('fill', '#ff4040'); dot.setAttribute('opacity', String(Math.max(0, Math.min(1, 1 - (frame.timestamp - laser[0].time) / 800)))); svg.append(dot);
        }
        for (let i = 1; i < laser.length; i++) {
            const a = worldToSurface(laser[i - 1], frame.view.camera), b = worldToSurface(laser[i], frame.view.camera);
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y)); line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
            line.setAttribute('stroke', '#ff4040'); line.setAttribute('stroke-linecap', 'round'); line.setAttribute('stroke-width', '3');
            line.setAttribute('opacity', String(Math.max(0, Math.min(1, 1 - (frame.timestamp - laser[i].time) / 800)))); svg.append(line);
        }
        if (brush || column) {
            const box = brush ?? (() => { const p = worldToSurface(column!, frame.view.camera); return { x: p.x, y: p.y,
                width: (column!.width ?? 1 / frame.view.camera.z) * frame.view.camera.z, height: 22 }; })();
            const rect = document.createElementNS(svgNS, 'rect');
            rect.setAttribute('x', String(box.x)); rect.setAttribute('y', String(box.y)); rect.setAttribute('width', String(box.width)); rect.setAttribute('height', String(box.height));
            rect.setAttribute('fill', 'rgba(80,145,255,0.12)'); rect.setAttribute('stroke', '#6a9fff'); rect.setAttribute('stroke-width', '1.5'); svg.append(rect);
        }
        scheduleLaser();
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
