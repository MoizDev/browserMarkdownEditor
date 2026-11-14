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
                    return manager.start(target.node, { anchor: target.offset, focus: target.offset });
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
    function pointer(sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<unknown> | null {
        cancelPending();
        const binding = manager.current;
        if (!ports.isCurrent() || !binding) return null;
        if (!ports.containsActive(event.clientX, event.clientY)) { manager.close(); return null; }
        const convert = (point: RealSample, keys: Modifiers): TextPointer => {
            const client = ports.worldToClient(point.x, point.y);
            return { id: point.pointerId, kind: point.source === 'touch' ? 'touch' : point.source === 'pen' ? 'pen' : 'mouse',
                x: client.x, y: client.y, clicks: event.detail, shift: keys.shift, accel: keys.accel };
        };
        const tool: Tool<unknown> = {
            id: 'text-selection',
            begin(first, keys): GestureOwner {
                binding.editor.pointerDown(convert(first, keys));
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
