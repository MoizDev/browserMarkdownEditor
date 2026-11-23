import type { CameraController, Point } from '../../platform/render/camera';
import type { PlatformPane } from '../../platform/render/attachPlatformPane.types';
import type { TouchPanSample } from '../../platform/render/scheduler';
import type { Viewport } from '../../platform/types';
import { installKeyboard } from '../input/keyboard';
import { installWheel, TouchArbiter, type ContactPoint } from '../input/navigation';

// Provenance: shared camera, touch arbiter, keyboard and scheduler contracts;
// independent read-only navigation adapter, no third-party source.
export interface BoardNavigationOptions {
    readonly surface: HTMLElement;
    readonly camera: CameraController;
    visible(): boolean;
    current(): boolean;
    viewport(): Viewport;
    platform(): Pick<PlatformPane, 'startFling' | 'animateZoom' | 'cancelMotion'> | null;
    changed(): void;
    interactionChanged?(active: boolean): void;
    onError(error: unknown): void;
    readonly mac: boolean;
    linkAt?(point: Point): (() => void) | null;
    contextMenu?(event: MouseEvent): void;
    readonly keyboard?: { modalOpen?(): boolean; editing?(): boolean; shortcutsEnabled?(): boolean };
    /** Preferences: whether the mouse wheel's zoom turn is inverted. */
    readonly invertMouseZoom?: () => boolean;
    readonly plainWheelZooms?: () => boolean;
}
interface Drag {
    id: number; origin: Point; last: Point; moved: boolean; secondary: boolean;
    open: (() => void) | null; samples: TouchPanSample[]; touch: boolean;
}
const attachments = new WeakMap<HTMLElement, () => void>();
export function attachBoardNavigation(options: BoardNavigationOptions): () => void {
    const { surface, camera } = options;
    attachments.get(surface)?.();
    let live = true, space = false, drag: Drag | null = null, suppressMenu = false;
    const previousTouchAction = surface.style.touchAction;
    surface.style.touchAction = 'none';
    const contacts = new Set<number>();
    let interacting = false;
    const reportInteraction = () => {
        const next = contacts.size > 0;
        if (next !== interacting) { interacting = next; options.interactionChanged?.(next); }
    };
    const active = () => live && options.visible() && options.current();
    const run = (fn: () => void) => { try { fn(); } catch (error) { options.onError(error); } };
    const point = (x: number, y: number): Point => {
        const bounds = surface.getBoundingClientRect(), viewport = options.viewport();
        if (![x, y, bounds.left, bounds.top, bounds.width, bounds.height, viewport.width, viewport.height].every(Number.isFinite)
            || bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new RangeError('Invalid navigation viewport');
        return { x: (x - bounds.left) * viewport.width / bounds.width, y: (y - bounds.top) * viewport.height / bounds.height };
    };
    const contact = (event: PointerEvent): ContactPoint => ({ ...point(event.clientX, event.clientY), id: event.pointerId,
        time: event.timeStamp, width: event.width, height: event.height });
    const cancelMotion = () => options.platform()?.cancelMotion();
    const release = (id: number) => { try { if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id); } catch { /* The browser may already have released it. */ } };
    const touch = new TouchArbiter(camera, {
        cancelTouchPreview() { if (drag?.touch) drag = null; },
        endTouchCamera() { if (active()) options.changed(); },
        changed() { if (active()) options.changed(); },
        penModeChanged() {},
    });
    const flush = () => {
        const ids = [...contacts]; contacts.clear(); drag = null; space = false; suppressMenu = false;
        for (const id of ids) { touch.touchUp(id); touch.penUp(id); release(id); }
        reportInteraction(); cancelMotion();
    };
    const samples = (d: Drag, p: Point, time: number) => {
        d.samples.push({ x: -p.x, y: -p.y, time: Math.max(0, time) });
        if (d.samples.length > 16) d.samples.shift();
    };
    const down = (event: PointerEvent) => run(() => {
        if (!active() || !(event.target instanceof Node) || !surface.contains(event.target)) return;
        if (event.pointerType !== 'touch' && event.button !== 0 && event.button !== 1 && event.button !== 2) return;
        cancelMotion();
        const p = point(event.clientX, event.clientY);
        const isTouch = event.pointerType === 'touch';
        const secondary = event.button === 2 || (options.mac && event.button === 0 && event.ctrlKey);
        if (isTouch) {
            const admitted = touch.touchDown({ ...p, id: event.pointerId, time: event.timeStamp, width: event.width, height: event.height });
            contacts.add(event.pointerId); reportInteraction();
            try { surface.setPointerCapture(event.pointerId); }
            catch { contacts.delete(event.pointerId); touch.touchUp(event.pointerId); reportInteraction(); return; }
            if (!admitted || drag) return;
        } else {
            if (drag) return;
            if (event.pointerType === 'pen') touch.penDown(event.pointerId, false);
            contacts.add(event.pointerId); reportInteraction();
            try { surface.setPointerCapture(event.pointerId); }
            catch { contacts.delete(event.pointerId); touch.penUp(event.pointerId); reportInteraction(); return; }
        }
        if (secondary) suppressMenu = false;
        const open = !secondary && event.button === 0 && !space && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
            ? options.linkAt?.(p) ?? null : null;
        drag = { id: event.pointerId, origin: p, last: p, moved: false, secondary, open, samples: [], touch: isTouch };
        samples(drag, p, event.timeStamp);
        if (event.button === 1) event.preventDefault();
    });
    const move = (event: PointerEvent) => run(() => {
        if (!active()) { flush(); return; }
        if (event.pointerType === 'touch' && contacts.has(event.pointerId)) touch.touchMove(contact(event));
        if (!drag || drag.id !== event.pointerId) return;
        const p = point(event.clientX, event.clientY), d = drag;
        if (!d.moved && Math.hypot(p.x - d.origin.x, p.y - d.origin.y) >= 4) {
            d.moved = true;
            if (d.secondary) suppressMenu = true;
        }
        if (d.moved) {
            camera.panBy({ x: d.last.x - p.x, y: d.last.y - p.y });
            samples(d, p, event.timeStamp); options.changed();
        }
        if (d.moved) d.last = p;
    });
    const end = (event: PointerEvent, cancelled: boolean) => run(() => {
        if (!contacts.has(event.pointerId)) return;
        const allowed = active(), d = drag?.id === event.pointerId ? drag : null;
        if (d) drag = null;
        contacts.delete(event.pointerId); reportInteraction();
        if (event.pointerType === 'touch') touch.touchUp(event.pointerId);
        if (event.pointerType === 'pen') touch.penUp(event.pointerId);
        release(event.pointerId);
        if (!allowed || cancelled || !d) return;
        if (!d.moved) { if (!d.secondary) d.open?.(); return; }
        if (d.touch) { samples(d, point(event.clientX, event.clientY), event.timeStamp); options.platform()?.startFling(d.samples); }
    });
    const up = (event: PointerEvent) => { if (contacts.has(event.pointerId) && active()) move(event); end(event, false); };
    const cancel = (event: PointerEvent) => end(event, true);
    const menu = (event: MouseEvent) => run(() => {
        if (!active()) return;
        if (suppressMenu) { suppressMenu = false; event.preventDefault(); return; }
        options.contextMenu?.(event);
    });
    const doubleClick = (event: MouseEvent) => run(() => {
        if (!active() || event.button !== 0) return;
        const anchor = point(event.clientX, event.clientY), platform = options.platform();
        if (!platform) return;
        platform.animateZoom(camera.camera.z * (event.shiftKey ? 0.5 : 2), anchor); options.changed(); event.preventDefault();
    });
    const aux = (event: MouseEvent) => { if (event.button === 1) event.preventDefault(); };
    surface.addEventListener('pointerdown', down); surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', up); surface.addEventListener('pointercancel', cancel); surface.addEventListener('lostpointercapture', cancel);
    surface.addEventListener('contextmenu', menu); surface.addEventListener('dblclick', doubleClick); surface.addEventListener('auxclick', aux);
    const stopWheel = installWheel(surface, { camera, paged: false, toSurface: point, invertZoom: () => options.invertMouseZoom?.() ?? false, plainWheelZooms: () => options.plainWheelZooms?.() ?? false,
        owns: () => { if (!active()) return false; options.viewport(); cancelMotion(); return true; }, changed: () => { if (active()) options.changed(); } });
    const stopKeyboard = installKeyboard(surface, {
        visible: active, enabled: () => false, modalOpen: () => !!document.querySelector('[aria-modal="true"]') || !!options.keyboard?.modalOpen?.(),
        editing: () => options.keyboard?.editing?.() ?? false, shortcutsEnabled: () => options.keyboard?.shortcutsEnabled?.() ?? true,
        gestureActive: () => contacts.size > 0,
        navigation: () => ({ paged: true, hasSelection: false, keyboardCursorActive: false,
            scroll(key) {
                if (key !== 'PageUp' && key !== 'PageDown') return false;
                run(() => { const viewport = options.viewport(); cancelMotion(); camera.panBy({ x: 0, y: viewport.height * 0.9 * (key === 'PageUp' ? -1 : 1) }); options.changed(); }); return true;
            },
            nudge: () => false,
            pan(direction, coarse) {
                const step = coarse ? 160 : 40;
                const delta = direction === 'ArrowLeft' ? { x: -step, y: 0 } : direction === 'ArrowRight' ? { x: step, y: 0 }
                    : direction === 'ArrowUp' ? { x: 0, y: -step } : { x: 0, y: step };
                run(() => { options.viewport(); cancelMotion(); camera.panBy(delta); options.changed(); }); return true;
            } }),
        run(id) {
            if (id === 'pan.release') { space = false; return true; }
            if (!active()) return false;
            if (id === 'pan.hold') { space = true; return true; }
            if (id === 'escape') { run(flush); return true; }
            return false;
        },
        clearLatches: () => run(flush),
    }, options.mac);
    const blur = () => run(flush);
    window.addEventListener('blur', blur); window.addEventListener('pagehide', blur);
    const detach = () => {
        if (!live) return;
        run(flush); live = false;
        surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointermove', move);
        surface.removeEventListener('pointerup', up); surface.removeEventListener('pointercancel', cancel); surface.removeEventListener('lostpointercapture', cancel);
        surface.removeEventListener('contextmenu', menu); surface.removeEventListener('dblclick', doubleClick); surface.removeEventListener('auxclick', aux);
        window.removeEventListener('blur', blur); window.removeEventListener('pagehide', blur);
        stopWheel(); stopKeyboard();
        if (surface.style.touchAction === 'none') surface.style.touchAction = previousTouchAction;
        if (attachments.get(surface) === detach) attachments.delete(surface);
    };
    attachments.set(surface, detach);
    return detach;
}
