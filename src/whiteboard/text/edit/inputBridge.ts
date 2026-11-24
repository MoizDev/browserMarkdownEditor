import type { GestureOwner, Modifiers, RealSample, Tool } from '../../input/tool';
import type { PointerRoute } from '../../input/pointerRouter';
import type { TextPointer } from './pointer';
import type { TextInputBridge, TextInputHit, TextInputRoutingPorts } from './managerTypes';

/** Adapts the pane's existing input router; no parallel pointer capture or camera owner. */
export function createTextInputBridge(ports: TextInputRoutingPorts): TextInputBridge {
    const { manager } = ports;
    let pending: AbortController | null = null;
    function cancelPending(): boolean {
        const request = pending;
        pending = null;
        request?.abort();
        return request !== null;
    }
    function type(text: string): boolean {
        cancelPending();
        const id = ports.selected();
        return ports.isCurrent() && id !== null && manager.type(id, text);
    }
    function enter(): boolean {
        cancelPending();
        const id = ports.selected();
        return ports.isCurrent() && id !== null && manager.start(id);
    }
    function doubleClick(x: number, y: number): boolean {
        cancelPending();
        if (!ports.isCurrent()) return false;
        if (manager.current && ports.containsActive(x, y)) return true;
        const request = new AbortController();
        pending = request;
        const binding = manager.current;
        const report = (error: unknown) => {
            if (pending !== request || request.signal.aborted) return;
            pending = null;
            ports.error(error);
        };
        try {
            const stillValid = ports.captureHit();
            const point = ports.clientToWorld(x, y);
            const resolve = (target: TextInputHit): boolean => {
                if (pending !== request || request.signal.aborted) return false;
                pending = null;
                try {
                    if (!ports.isCurrent() || !stillValid() || manager.current !== binding || target === null) return false;
                    // Use the original point: a deferred blank hit must never move with a later camera.
                    if (target === 'blank') return manager.create(point.x, point.y, null) !== null;
                    return manager.start(target.node);
                } catch (error) { ports.error(error); return false; }
            };
            const target = ports.locate(x, y, request.signal);
            if (isDeferred(target)) {
                // The pending double click is consumed, but never owns pointer capture.
                void Promise.resolve(target).then(resolve).catch(error => {
                    try { report(error); } catch { /* Error reporting must not leave a rejected input task. */ }
                });
                return true;
            }
            return resolve(target);
        } catch (error) { report(error); return false; }
    }
    function editOnRelease(event: PointerEvent): void {
        const down = { x: event.clientX, y: event.clientY }, pointerId = event.pointerId;
        const release = (up: PointerEvent) => {
            if (up.pointerId !== pointerId) return;
            window.removeEventListener('pointerup', release, true);
            window.removeEventListener('pointercancel', cancel, true);
            if (Math.hypot(up.clientX - down.x, up.clientY - down.y) > 8) return;
            // Next task: Select's own release has finished first, so it cannot undo the selection the label edit needs.
            setTimeout(() => {
                if (!ports.isCurrent()) return;
                const controller = new AbortController();
                void Promise.resolve(ports.locate(down.x, down.y, controller.signal)).then(target => {
                    if (target && typeof target === 'object' && ports.isCurrent()) manager.start(target.node);
                }).catch(error => { if (!controller.signal.aborted) ports.error(error); });
            }, 0);
        };
        const cancel = (gone: PointerEvent) => {
            if (gone.pointerId !== pointerId) return;
            window.removeEventListener('pointerup', release, true);
            window.removeEventListener('pointercancel', cancel, true);
        };
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', cancel, true);
    }
    function pointer(sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<unknown> | null {
        cancelPending();
        const binding = manager.current;
        if (!ports.isCurrent() || !binding) return null;
        const handle = event.pointerType === 'touch' ? ports.hitHandle(event.clientX, event.clientY) : null;
        // With the input blurred (focus left for a chrome control, measured: the caret stayed and a drag from the shape only
        // selected text), a press on the editing shape ends the edit and goes to Select, so a drag moves the shape (catalogue S§16).
        const inside = ports.containsActive(event.clientX, event.clientY);
        if (!handle && (!inside || !binding.editor.hasFocus())) {
            manager.close();
            // A release without a drag on another shape's label edits that label (catalogue S§16): Select takes the press
            // and selects the shape, then the label opens once that press has finished.
            if (!inside) editOnRelease(event);
            return null;
        }
        // A press the editor keeps keeps focus too: the browser's mousedown default would move it to the board root, and the next
        // press on the text would then read as a blurred editor (measured: a drag inside the label dropped the typing focus).
        if (event.pointerType !== 'touch') event.preventDefault();
        const convert = (point: RealSample, keys: Modifiers): TextPointer => {
            const client = ports.worldToClient(point.x, point.y);
            return { id: point.pointerId, kind: point.source === 'touch' ? 'touch' : point.source === 'pen' ? 'pen' : 'mouse',
                x: client.x, y: client.y, clicks: event.detail, shift: keys.shift, accel: keys.accel };
        };
        const tool: Tool<unknown> = {
            id: 'text-selection',
            begin(first, keys): GestureOwner {
                binding.editor.pointerDown(convert(first, keys), handle ?? undefined);
                return {
                    kind: 'node-edit', pointerIds: new Set([first.pointerId]),
                    update(samples, nextKeys) { for (const point of samples) if (point.pointerId === first.pointerId) binding.editor.pointerMove(convert(point, nextKeys)); },
                    finish() { binding.editor.pointerUp(first.pointerId); },
                    cancel() { binding.editor.pointerUp(first.pointerId); },
                };
            },
        };
        return { tool, context: undefined };
    }
    return { type, enter, doubleClick, pointer, cancelPending, flush: () => { cancelPending(); manager.close(); } };
}

function isDeferred(hit: TextInputHit | Promise<TextInputHit>): hit is Promise<TextInputHit> {
    return hit !== null && typeof hit === 'object' && 'then' in hit && typeof hit.then === 'function';
}
