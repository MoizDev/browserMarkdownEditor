/** Whether each registered pane is moving (a fling, a zoom, or an interaction the pane reports) and when it last stopped.
 * The scheduler publishes it on the frame that sets the camera's moving flag, and the surface broker's upgrade waits for a
 * quiet window after it, so a motion that outlives its last input is still seen. A separate module, so the broker does not
 * import the scheduler (which awaits its benchmark module at load). Removed on unregister. */
export interface PaneMotionState { readonly moving: boolean; readonly stoppedAt: number }

interface MutableMotion { moving: boolean; stoppedAt: number }
const motionByPane = new Map<string, MutableMotion>();
const NOT_MOVING: PaneMotionState = Object.freeze({ moving: false, stoppedAt: -Infinity });

export function paneMotionState(paneId: string): PaneMotionState { return motionByPane.get(paneId) ?? NOT_MOVING; }

export function recordPaneMotion(paneId: string, moving: boolean): void {
    let state = motionByPane.get(paneId);
    if (!state) {
        if (!moving) return;
        state = { moving: false, stoppedAt: -Infinity };
        motionByPane.set(paneId, state);
    }
    if (moving) state.moving = true;
    else if (state.moving) { state.moving = false; state.stoppedAt = performance.now(); }
}

export function forgetPaneMotion(paneId: string): void { motionByPane.delete(paneId); }
