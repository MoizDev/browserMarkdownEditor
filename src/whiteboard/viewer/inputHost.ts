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
import type { ViewerEngine, ViewerInteractionPorts } from './types';
import { createBoardWetLayer } from './wetLayer';

// Provenance: input routing, presented mapping, viewer interaction and shared
// scheduler contracts; independent view-owned wiring, no third-party source.
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
    services(surface: HTMLElement, overlay: HTMLElement, wet: BoardWetLayer): BoardInputServices;
    invalidate(): void;
    onError(error: unknown): void;
    readonly overlays?: {
        write(frame: ScheduledFrame, overlay: HTMLElement): void;
        finishComposition(): void;
        captureText?: ViewerInteractionPorts['captureText'];
        restoreText?: ViewerInteractionPorts['restoreText'];
        beforeHistoryReplay?: ViewerInteractionPorts['beforeHistoryReplay'];
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
        presented: (revision, actual, frame) => wet.presented(revision, actual, frame),
        liveNodeIds: () => wet.liveNodeIds(),
    };
    const stopInteraction = options.engine.bindInteractions(interaction);
    const stopAttachment = () => {
        const stop = attached; attached = null;
        if (stop) { safe(stop); notifyAttachment(); }
        contacts.clear(); flush = null;
    };
    const clientToSurface = (x: number, y: number): Point => {
        if (!binding) throw new Error('Input surface is not attached');
        const box = binding.surface.getBoundingClientRect(), viewport = options.viewport();
        if (box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new RangeError('Input surface has no viewport');
        return { x: (x - box.left) * viewport.width / box.width, y: (y - box.top) * viewport.height / box.height };
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
        const services = options.services(surface, overlay, wet);
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
        const down = (event: PointerEvent) => { if (enabled && current()) contacts.add(event.pointerId); };
        const end = (event: PointerEvent) => { contacts.delete(event.pointerId); };
        surface.addEventListener('pointerdown', down); surface.addEventListener('pointerup', end);
        surface.addEventListener('pointercancel', end); surface.addEventListener('lostpointercapture', end);
        let detach: () => void;
        try { detach = attachBoardInput(view, options.session, services, options.mode); }
        catch (error) {
            surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointerup', end);
            surface.removeEventListener('pointercancel', end); surface.removeEventListener('lostpointercapture', end); throw error;
        }
        attached = () => {
            try { detach(); } finally {
                surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointerup', end);
                surface.removeEventListener('pointercancel', end); surface.removeEventListener('lostpointercapture', end);
            }
        };
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
    return {
        attachInput, mappings, sampleToSurface, clientToSurface,
        isAttached: () => attached !== null && !disposed,
        subscribeAttachment(listener: (attached: boolean) => void) {
            if (disposed) return () => {};
            attachmentListeners.add(listener);
            return () => { attachmentListeners.delete(listener); };
        },
        layers: wet.layers,
        schedule(callback: () => void) {
            if (disposed) return () => {};
            scheduled.add(callback); options.invalidate();
            return () => { scheduled.delete(callback); };
        },
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
