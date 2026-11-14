import type { GestureOwner, Modifiers, RealSample, Tool } from '../../input/tool';
import type { PointerRoute } from '../../input/pointerRouter';
import type { TextPointer } from './pointer';
import type { TextInputBridge, TextInputRoutingPorts } from './managerTypes';

/** Adapts the pane's existing input router; no parallel pointer capture or camera owner. */
export function createTextInputBridge(ports: TextInputRoutingPorts): TextInputBridge {
    const { manager } = ports;
    function type(text: string): boolean {
        const id = ports.selected();
        return id !== null && manager.type(id, text);
    }
    function enter(): boolean {
        const id = ports.selected();
        return id !== null && manager.start(id);
    }
    function doubleClick(x: number, y: number): boolean {
        if (manager.current && ports.containsActive(x, y)) return true;
        const target = ports.locate(x, y);
        if (target === null) return false;
        if (target === 'blank') {
            const point = ports.clientToWorld(x, y);
            return manager.create(point.x, point.y, null) !== null;
        }
        return manager.start(target.node, { anchor: target.offset, focus: target.offset });
    }
    function pointer(sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<unknown> | null {
        const binding = manager.current;
        if (!binding) return null;
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
    return { type, enter, doubleClick, pointer, flush: () => manager.close() };
}
