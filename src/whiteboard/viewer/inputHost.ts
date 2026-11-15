import { surfaceToWorld, worldToSurface, type CameraController, type Point } from '../../platform/render/camera';
import type { PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { RenderToken } from '../../platform/render/types';
import type { Viewport } from '../../platform/types';
import type { BoardRuntime } from '../host/runtime';
import { attachBoardInput, type BoardInputMode, type BoardInputServices, type BoardInputView, type BoardWetLayer } from '../input/attach';
import { MappingHistory, presentedMapping } from '../input/pointer';
import type { InputToken, RealSample } from '../input/tool';
import type { BoardSession } from '../session/BoardSession';
import type { PaintSource } from '../render/paintStream';
import type { ViewerPaintPresentation } from '../render/paintPresentation';
import type { ViewerEngine, ViewerInteractionPorts } from './types';
import { createBoardWetLayer } from './wetLayer';
import { NO_SENSITIVE_IDS } from './sensitiveTargets';

// Provenance: input routing, presented mapping, viewer interaction and shared
// scheduler contracts; independent view-owned wiring, no third-party source.
/** The host's own mapping and scheduling ports, handed to the services factory once per attachment. */
export interface BoardInputHostPorts {
    readonly mappings: MappingHistory;
    sampleToSurface(sample: RealSample): Point;
    clientToSurface(x: number, y: number): Point;
    schedule(callback: () => void): () => void;
}
export interface BoardInputHostOptions {
    readonly session: BoardSession;
    readonly runtime: BoardRuntime;
    readonly engine: ViewerEngine;
    readonly token: RenderToken;
    readonly inputToken: InputToken;
    readonly camera: CameraController;
    readonly viewport: () => Viewport;
    readonly current: (token: RenderToken) => boolean;
    readonly visible: () => boolean;
    readonly focused: () => boolean;
    readonly mode: BoardInputMode;
    readonly a11y: BoardInputView['a11y'];
    readonly paged: boolean;
    services(surface: HTMLElement, overlay: HTMLElement, wet: BoardWetLayer, ports: BoardInputHostPorts): BoardInputServices;
    /** Called after an attachment's listeners are removed, so per-attachment services can release. */
    released?(): void;
    /** Composable observer of each actual presented frame; the wet layer always runs first. */
    presented?(revision: number, token: RenderToken, frame?: PaintSource, context?: ViewerPaintPresentation): void;
    invalidate(): void;
    onError(error: unknown): void;
    readonly overlays?: {
        write(frame: ScheduledFrame, overlay: HTMLElement): void;
        finishComposition(): void;
        captureText?: ViewerInteractionPorts['captureText'];
        restoreText?: ViewerInteractionPorts['restoreText'];
        beforeHistoryReplay?: ViewerInteractionPorts['beforeHistoryReplay'];
        /** Hover and edit targets from the tool set bound to this attachment. */
        sensitiveNodeIds?(): ReadonlySet<string>;
        dispose?(): void;
    };
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
export function createBoardInputHost(options: BoardInputHostOptions) {
    if (options.runtime.session !== options.session || options.engine.session !== options.session) throw new Error('Input host must use the existing board session');
    const token = Object.freeze({ ...options.token }), inputToken = Object.freeze({ ...options.inputToken });
    let disposed = false, enabled = false, attached: (() => void) | null = null, flush: (() => void) | null = null;
    let binding: { surface: HTMLElement; overlay: HTMLElement } | null = null, presented: PlatformPresentation | null = null;
    let presentedAt = 0;
    let pointerClient: { id: number; kind: string; x: number; y: number } | null = null;
    const contacts = new Set<number>();
    const scheduled = new Set<() => void>();
    const attachmentListeners = new Set<(attached: boolean) => void>();
    const current = () => !disposed && options.visible() && options.current(token);
    const report = (error: unknown) => { try { options.onError(error); } catch { /* reporting cannot block cleanup */ } };
    const safe = (fn: () => void) => { try { fn(); } catch (error) { report(error); } };
    const notifyAttachment = () => { for (const listener of [...attachmentListeners]) safe(() => listener(attached !== null)); };
    const wet = createBoardWetLayer({ token, palette: () => options.engine.getSnapshot().palette,
        readyFrame: () => options.engine.readyPaintFrame(), current,
        exists: identity => options.session.doc.rev < identity.nodeRevision || options.session.doc.nodes.has(identity.nodeId as import('../model/ids').NodeId),
        invalidate: options.invalidate, onError: report });
    options.engine.setInteractionLayers(wet.layers);
    const mappings = new MappingHistory();
    const interaction: ViewerInteractionPorts = {
        finishGesture: () => { if (flush) safe(flush); },
        finishComposition: () => safe(() => options.overlays?.finishComposition()),
        captureText: () => options.overlays?.captureText?.(),
        restoreText: value => options.overlays?.restoreText?.(value),
        beforeHistoryReplay: (step, direction) => options.overlays?.beforeHistoryReplay?.(step, direction) ?? true,
        presented: (revision, actual, frame, context) => {
            wet.presented(revision, actual, frame);
            if (options.presented) safe(() => options.presented?.(revision, actual, frame, context));
        },
        liveNodeIds: () => wet.liveNodeIds(),
        paletteChanged: () => wet.invalidate(),
        sensitiveNodeIds: () => options.overlays?.sensitiveNodeIds?.() ?? NO_SENSITIVE_IDS,
    };
    const stopInteraction = options.engine.bindInteractions(interaction);
    const stopAttachment = () => {
        const stop = attached; attached = null; pointerClient = null;
        if (stop) { safe(stop); notifyAttachment(); safe(() => options.released?.()); }
        contacts.clear(); flush = null;
    };
    const clientToSurface = (x: number, y: number): Point => {
        if (!binding) throw new Error('Input surface is not attached');
        const box = binding.surface.getBoundingClientRect(), viewport = options.viewport();
        if (box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new RangeError('Input surface has no viewport');
        return presentedMapping(performance.now(), box, viewport, options.camera.camera).clientToSurface(x, y);
    };
    const sampleToSurface = (sample: RealSample): Point => {
        if (sample.source === 'keyboard') return worldToSurface(sample, options.camera.camera);
        if (typeof sample.surfaceX === 'number' && typeof sample.surfaceY === 'number'
            && Number.isFinite(sample.surfaceX) && Number.isFinite(sample.surfaceY)) return { x: sample.surfaceX, y: sample.surfaceY };
        const client = mappings.unmap(sample.time, sample);
        return mappings.surface(sample.time, client.x, client.y);
    };
    const connect = () => {
        if (!binding || attached || !enabled || !current()) return;
        const { surface, overlay } = binding;
        const services = options.services(surface, overlay, wet, { mappings, sampleToSurface, clientToSurface, schedule });
        const view: BoardInputView = {
            surface, camera: options.camera, wet, token: inputToken, mappings, a11y: options.a11y, paged: options.paged,
            visible: () => enabled && current(), current: value => value.vaultEpoch === inputToken.vaultEpoch && value.tabId === inputToken.tabId
                && value.sessionGeneration === inputToken.sessionGeneration && value.viewGeneration === inputToken.viewGeneration && current(),
            bindFlush(callback) { flush = callback; return () => { if (flush === callback) flush = null; }; },
            sampleToSurface, clientToSurface,
            predictionMapping() {
                const camera = { ...options.camera.camera }, viewport = { ...options.viewport() }, rect = surface.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new RangeError('Input surface has no prediction viewport');
                return { clientToSurface: (x, y) => ({ x: (x - rect.left) * viewport.width / rect.width, y: (y - rect.top) * viewport.height / rect.height }),
                    surfaceToWorld: (x, y) => surfaceToWorld({ x, y }, camera),
                    permits: (x, y) => x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height };
            },
        };
        const rememberPointer = (event: PointerEvent) => {
            if (!enabled || !current() || !event.isPrimary || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
            pointerClient = { id: event.pointerId, kind: event.pointerType, x: event.clientX, y: event.clientY };
        };
        const leave = (event: PointerEvent) => { if (pointerClient?.id === event.pointerId) pointerClient = null; };
        const down = (event: PointerEvent) => { rememberPointer(event); if (enabled && current()) contacts.add(event.pointerId); };
        const end = (event: PointerEvent) => {
            if (pointerClient?.id === event.pointerId && (pointerClient.kind === 'touch' || event.type === 'pointercancel')) pointerClient = null;
            contacts.delete(event.pointerId);
        };
        surface.addEventListener('pointermove', rememberPointer); surface.addEventListener('pointerenter', rememberPointer);
        surface.addEventListener('pointerleave', leave);
        surface.addEventListener('pointerdown', down); surface.addEventListener('pointerup', end);
        surface.addEventListener('pointercancel', end); surface.addEventListener('lostpointercapture', end);
        const removeListeners = () => {
            surface.removeEventListener('pointermove', rememberPointer); surface.removeEventListener('pointerenter', rememberPointer);
            surface.removeEventListener('pointerleave', leave);
            surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointerup', end);
            surface.removeEventListener('pointercancel', end); surface.removeEventListener('lostpointercapture', end);
            pointerClient = null;
        };
        let detach: () => void;
        try { detach = attachBoardInput(view, options.session, services, options.mode); }
        catch (error) { removeListeners(); throw error; }
        attached = () => { try { detach(); } finally { removeListeners(); } };
        // Constructing services is not input readiness: the browser listeners,
        // router and session gesture bridge must all have attached successfully.
        notifyAttachment();
    };
    const attachInput = (surface: HTMLElement, overlay: HTMLElement): (() => void) => {
        if (disposed) throw new Error('Input host disposed');
        stopAttachment(); binding = { surface, overlay }; safe(connect);
        let removed = false;
        return () => { if (removed) return; removed = true; if (binding?.surface === surface && binding.overlay === overlay) { stopAttachment(); binding = null; } };
    };
    const schedule = (callback: () => void): (() => void) => {
        if (disposed) return () => {};
        scheduled.add(callback); options.invalidate();
        return () => { scheduled.delete(callback); };
    };
    return {
        attachInput, mappings, sampleToSurface, clientToSurface, schedule,
        isAttached: () => attached !== null && !disposed,
        pointerSurface(): Point | null {
            if (!current() || !enabled || !attached || !binding || !pointerClient) return null;
            const rect = binding.surface.getBoundingClientRect(), viewport = options.viewport();
            if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
            // Actual browser coordinates survive camera/layout changes. An old
            // world point is not a certificate of the cursor's physical position.
            const point = clientToSurface(pointerClient.x, pointerClient.y);
            return point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height ? point : null;
        },
        subscribeAttachment(listener: (attached: boolean) => void) {
            if (disposed) return () => {};
            attachmentListeners.add(listener);
            return () => { attachmentListeners.delete(listener); };
        },
        layers: wet.layers,
        consumeInput(_timestamp: number) {
            if (!current() || !enabled) { stopAttachment(); scheduled.clear(); return; }
            safe(connect); safe(() => wet.consumeInput());
            const ready = [...scheduled]; scheduled.clear();
            for (const callback of ready) safe(callback);
        },
        isInteracting() { return current() && (contacts.size > 0 || options.session.isGestureActive); },
        setInputEnabled(value: boolean) { if (disposed || enabled === value) return; enabled = value; if (!value) { stopAttachment(); scheduled.clear(); } else safe(connect); },
        cancelViewWork(_reason: string) { stopAttachment(); scheduled.clear(); presented = null; },
        writeOverlays(frame: ScheduledFrame) {
            if (!binding || !current() || !presented || presented.frameId !== frame.frameId || !sameToken(frame.token, token)) return;
            safe(() => {
                const rect = binding!.surface.getBoundingClientRect(), viewport = frame.view.viewport, camera = { ...frame.view.camera };
                if (rect.width > 0 && rect.height > 0 && viewport.width > 0 && viewport.height > 0) {
                    mappings.present(presentedMapping(presentedAt, rect, viewport, camera));
                }
                options.overlays?.write(frame, binding!.overlay);
            });
        },
        onPresentation(value: PlatformPresentation | null) {
            presented = value && current() && sameToken(value.token, token) ? value : null;
            if (presented) presentedAt = performance.now();
        },
        dispose() {
            if (disposed) return;
            stopAttachment(); attachmentListeners.clear(); scheduled.clear(); disposed = true; binding = null; presented = null;
            safe(stopInteraction); safe(() => options.engine.setInteractionLayers(null)); safe(() => wet.dispose()); safe(() => options.overlays?.dispose?.());
        },
    };
}
