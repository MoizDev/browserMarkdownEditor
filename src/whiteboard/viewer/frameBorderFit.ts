import { worldToLocal } from '../change/coordinates';
import { isLocked } from '../change/commands';
import { prepareBoardFrameFit } from '../commands/fitFrame';
import type { BoardRuntime } from '../host/runtime';

/** Which border a frame-local point sits on. A corner is on both edges and fits both axes; an edge fits its own axis. */
export function frameBorderAxes(frame: Readonly<{ w: number; h: number }>, local: Readonly<{ x: number; y: number }>, band: number): 'both' | 'x' | 'y' | null {
    const inX = local.x >= -band && local.x <= frame.w + band, inY = local.y >= -band && local.y <= frame.h + band;
    const onLeftOrRight = inY && (Math.abs(local.x) <= band || Math.abs(local.x - frame.w) <= band);
    const onTopOrBottom = inX && (Math.abs(local.y) <= band || Math.abs(local.y - frame.h) <= band);
    if (onLeftOrRight && onTopOrBottom) return 'both';
    if (onLeftOrRight) return 'x';
    if (onTopOrBottom) return 'y';
    return null;
}

/** Double-clicking the border of the one selected frame fits it to its children. The band is a screen distance, so
 * the border is as easy to hit at every zoom. False leaves the double-click to the other handlers (its body, its name). */
export function fitFrameAtBorder(options: { readonly runtime: BoardRuntime; readonly point: Readonly<{ x: number; y: number }>; readonly bandWorld: number;
    readonly current: () => boolean; readonly registerPending: (cancel: () => void) => () => void; readonly error: (error: unknown) => void }): boolean {
    const { runtime } = options, doc = runtime.session.doc, selected = runtime.selection.getSnapshot().selected;
    if (selected.length !== 1) return false;
    const frame = doc.nodes.get(selected[0]);
    if (!frame || frame.kind !== 'frame' || isLocked(doc, frame)) return false;
    const axes = frameBorderAxes(frame, worldToLocal(doc, frame, options.point), options.bandWorld);
    if (!axes) return false;
    const controller = new AbortController();
    const unregister = options.registerPending(() => controller.abort());
    prepareBoardFrameFit({ runtime, id: frame.id, axes, current: options.current, signal: controller.signal })
        .then(plan => plan.commit())
        .catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) options.error(error); })
        .finally(() => unregister());
    return true;
}
