import type { CameraController, Point } from '../../platform/render/camera';
import type { PlatformPane, PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { FrameToken } from '../../platform/render/types';
import type { Viewport } from '../../platform/types';
import { presentedMapping, type MappingHistory } from '../input/pointer';
import { attachBoardNavigation, type BoardNavigationOptions } from './navigationInput';

export interface BoardNavigationHostOptions {
    readonly camera: CameraController;
    readonly viewport: () => Viewport;
    readonly platform: () => Pick<PlatformPane, 'startFling' | 'animateZoom' | 'animatePan' | 'cancelMotion'> | null;
    readonly visible: () => boolean;
    readonly current: () => boolean;
    readonly changed: () => void;
    readonly onUserNavigation?: () => void;
    readonly invalidate: () => void;
    readonly onError: (error: unknown) => void;
    readonly mac: boolean;
    readonly linkAt?: (point: Point) => (() => void) | null;
    readonly contextMenu?: (event: MouseEvent) => void;
    readonly keyboard?: BoardNavigationOptions['keyboard'];
    readonly invertMouseZoom?: () => boolean;
    readonly mouseWheel?: () => boolean;
    readonly reducedMotion?: () => boolean;
    readonly mappings?: MappingHistory;
    readonly overlay?: (frame: ScheduledFrame, element: HTMLElement) => void;
    readonly presented?: (presentation: PlatformPresentation | null) => void;
}
export interface BoardNavigationHost {
    attachInput(surface: HTMLElement, overlay: HTMLElement): () => void;
    consumeInput(timestamp: number): void;
    isInteracting(): boolean;
    setInputEnabled(enabled: boolean): void;
    cancelViewWork(reason: string): void;
    writeOverlays(frame: ScheduledFrame): void;
    onPresentation(presentation: PlatformPresentation | null): void;
    getSnapshot(): Readonly<{ inputEnabled: boolean; interacting: boolean; presentation: PlatformPresentation | null; overlayFrameId: number | null }>;
    dispose(): void;
}
function sameToken(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration
        && a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}

export function createBoardNavigationHost(options: BoardNavigationHostOptions): BoardNavigationHost {
    let enabled = true, disposed = false, cancelling = false, contact = false, generation = 0;
    let binding: { surface: HTMLElement; overlay: HTMLElement; generation: number } | null = null;
    let detach: (() => void) | null = null, queued: number | null = null;
    let presentation: PlatformPresentation | null = null, presentedAt = 0, overlayFrameId: number | null = null;
    let lastMotion: { x: number; y: number; z: number } | null = null;
    const active = () => !disposed && enabled && !cancelling && options.visible() && options.current();
    const report = (error: unknown) => { try { options.onError(error); } catch { /* preserve scheduler ownership */ } };
    const invalidate = () => { if (active()) options.invalidate(); };
    const stop = () => {
        const old = detach; detach = null;
        if (old) old();
        contact = false;
    };
    const mount = () => {
        if (!binding || detach || disposed || !enabled || cancelling) return;
        const captured = binding;
        detach = attachBoardNavigation({ surface: captured.surface, camera: options.camera, viewport: options.viewport,
            platform: options.platform, visible: active, current: () => active() && binding === captured,
            mac: options.mac, linkAt: options.linkAt, contextMenu: options.contextMenu, keyboard: options.keyboard, invertMouseZoom: options.invertMouseZoom, mouseWheel: options.mouseWheel, reducedMotion: options.reducedMotion,
            onError: report,
            interactionChanged(value) { if (binding === captured) { contact = value; invalidate(); } },
            changed() {
                if (!active() || binding !== captured) return;
                try { options.onUserNavigation?.(); } catch (error) { report(error); }
                queued = captured.generation;
                invalidate();
            },
        });
    };
    const cancel = () => {
        cancelling = true;
        try { stop(); options.platform()?.cancelMotion(); }
        finally { queued = null; contact = false; presentation = null; overlayFrameId = null; lastMotion = null; cancelling = false; }
    };
    return {
        attachInput(surface, overlay) {
            if (disposed) throw new Error('Navigation host is disposed');
            cancel();
            const captured = { surface, overlay, generation: ++generation };
            binding = captured; mount();
            return () => {
                if (binding !== captured) return;
                cancel(); binding = null; generation++;
            };
        },
        consumeInput(timestamp) {
            if (!Number.isFinite(timestamp)) throw new RangeError('Invalid input frame time');
            const pending = queued; queued = null;
            if (pending !== null && active() && binding?.generation === pending) options.changed();
        },
        // The scheduler tracks fling/zoom motion itself; feeding frame.moving back here
        // would latch moving forever after a contact ends.
        isInteracting() { return active() && contact; },
        setInputEnabled(value) {
            if (disposed || enabled === value) return;
            enabled = value;
            if (!enabled) cancel(); else mount();
        },
        cancelViewWork(_reason) { if (!disposed) { cancel(); mount(); } },
        writeOverlays(frame) {
            if (!active() || !binding) return;
            overlayFrameId = frame.frameId;
            const camera = frame.view.camera;
            if (!contact && (frame.view.moving || lastMotion)) {
                if (!lastMotion || camera.x !== lastMotion.x || camera.y !== lastMotion.y || camera.z !== lastMotion.z || !frame.view.moving) {
                    queued = binding.generation; invalidate();
                }
                lastMotion = frame.view.moving ? { ...camera } : null;
            } else if (contact) lastMotion = null;
            const shown = presentation;
            if (shown && shown.frameId === frame.frameId && shown.viewEpoch === frame.view.epoch && sameToken(shown.token, frame.token)) {
                if (options.mappings) {
                    const bounds = binding.surface.getBoundingClientRect(), view = frame.view;
                    if (bounds.width > 0 && bounds.height > 0 && view.viewport.width > 0 && view.viewport.height > 0) {
                        options.mappings.present(presentedMapping(presentedAt, bounds, view.viewport, view.camera));
                    }
                }
            }
            options.overlay?.(frame, binding.overlay);
        },
        onPresentation(value) {
            if (disposed || (value && !active())) return;
            presentation = value; presentedAt = performance.now();
            options.presented?.(value);
        },
        getSnapshot() { return { inputEnabled: enabled && !disposed, interacting: active() && contact, presentation, overlayFrameId }; },
        dispose() {
            if (disposed) return;
            disposed = true; enabled = false; cancel(); binding = null; generation++;
        },
    };
}
