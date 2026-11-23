import type { CameraController } from '../../platform/render/camera';
import type { Viewport } from '../../platform/types';

/** One Space+arrow page takes the Editor's 320 ms, the length a person reads as one motion (K§10.5). */
const PAGE_MS = 320;

export interface CameraPager {
    /** Pages one viewport toward the arrow; false when the key is not an arrow or the view has no size. */
    page(direction: string): boolean;
    /** Ends a page in flight; the camera keeps wherever it has reached. */
    stop(): void;
}

/** The page is animated frame by frame through the pane's own controller, so the paper constraint still applies. */
export function createCameraPager(options: {
    readonly camera: CameraController;
    readonly viewport: () => Viewport;
    readonly active: () => boolean;
    readonly changed: () => void;
    readonly reducedMotion: () => boolean;
    readonly error: (error: unknown) => void;
}): CameraPager {
    const { camera } = options;
    let stopCurrent: (() => void) | null = null;
    const stop = (): void => { stopCurrent?.(); };
    const animate = (delta: { x: number; y: number }): void => {
        const startedAt = performance.now();
        let applied = { x: 0, y: 0 }, expected = { ...camera.camera }, frame = 0;
        const finish = (): void => {
            if (frame) cancelAnimationFrame(frame);
            frame = 0; stopCurrent = null; camera.setMoving(false);
        };
        // A frame that finds the camera moved by someone else (a wheel, a drag) ends the page rather than fighting it.
        const step = (now: number): void => {
            frame = 0;
            const shown = camera.camera;
            if (!options.active() || shown.x !== expected.x || shown.y !== expected.y || shown.z !== expected.z) { finish(); return; }
            const t = Math.min(1, Math.max(0, (now - startedAt) / PAGE_MS)), eased = 1 - (1 - t) ** 3;
            const next = { x: delta.x * eased, y: delta.y * eased };
            camera.panBy({ x: next.x - applied.x, y: next.y - applied.y });
            applied = next; expected = { ...camera.camera };
            options.changed();
            if (t >= 1) finish(); else frame = requestAnimationFrame(step);
        };
        stopCurrent = finish;
        camera.setMoving(true);
        frame = requestAnimationFrame(step);
    };
    return {
        stop,
        page(direction) {
            if (!options.active()) return false;
            const view = options.viewport();
            if (![view.width, view.height].every(Number.isFinite) || view.width <= 0 || view.height <= 0) return false;
            const delta = direction === 'ArrowLeft' ? { x: -view.width, y: 0 } : direction === 'ArrowRight' ? { x: view.width, y: 0 }
                : direction === 'ArrowUp' ? { x: 0, y: -view.height } : direction === 'ArrowDown' ? { x: 0, y: view.height } : null;
            if (!delta) return false;
            stop();
            try {
                if (options.reducedMotion()) { camera.panBy(delta); options.changed(); return true; }
                animate(delta);
                return true;
            } catch (error) { options.error(error); return false; }
        },
    };
}
