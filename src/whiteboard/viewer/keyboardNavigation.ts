import type { CameraController } from '../../platform/render/camera';
import type { Viewport } from '../../platform/types';
import type { BoardRuntime } from '../host/runtime';
import type { KeyboardNavigationPriority, PagedScrollKey } from '../input/scrollKeysTypes';
import { boardPageStack } from '../model/pages';

export interface BoardKeyboardNavigationOptions {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    readonly viewport: () => Viewport;
    readonly paged: boolean;
    readonly current: () => boolean;
    readonly editable: () => boolean;
    readonly nudge: (direction: string, coarse: boolean) => boolean;
    readonly cancelMotion: () => void;
    readonly cancelReveal: () => void;
    readonly changed: () => void;
    readonly error: (error: unknown) => void;
}

/** Keyboard camera work goes through the pane's existing controller and constraints. */
export function createBoardKeyboardNavigation(options: BoardKeyboardNavigationOptions): (keyboardCursorActive: boolean) => KeyboardNavigationPriority {
    const { runtime, camera } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const active = () => options.current() && session.owner === owner && session.doc === doc;
    const cameraAction = (action: () => void): boolean => {
        if (!active()) return false;
        try {
            options.cancelReveal(); options.cancelMotion();
            action(); options.changed(); return true;
        } catch (error) { options.error(error); return false; }
    };
    const scroll = (key: PagedScrollKey): boolean => {
        if (!options.paged || !active()) return false;
        const stack = boardPageStack(doc.host), viewport = options.viewport();
        if (!stack?.rects.length || !Number.isFinite(viewport.height) || viewport.height <= 0) return false;
        if (key === 'Home' || key === 'End') {
            return cameraAction(() => camera.setCamera({ ...camera.camera, y: key === 'Home' ? 0 : stack.height }));
        }
        const sign = key === 'PageUp' || key === 'ShiftSpace' ? -1 : 1;
        // Default: page keys move 90% of the visible height to preserve reading context.
        return cameraAction(() => camera.panBy({ x: 0, y: sign * viewport.height * 0.9 }));
    };
    const pan = (direction: string, coarse: boolean): boolean => {
        const step = coarse ? 160 : 40;
        const delta = direction === 'ArrowLeft' ? { x: -step, y: 0 } : direction === 'ArrowRight' ? { x: step, y: 0 }
            : direction === 'ArrowUp' ? { x: 0, y: -step } : direction === 'ArrowDown' ? { x: 0, y: step } : null;
        if (!delta) return false;
        return cameraAction(() => camera.panBy(delta));
    };
    return keyboardCursorActive => ({
        paged: options.paged,
        hasSelection: active() && runtime.selection.getSnapshot().selected.length > 0,
        keyboardCursorActive,
        scroll,
        nudge: (direction, coarse) => active() && options.editable() && options.nudge(direction, coarse),
        pan,
    });
}
