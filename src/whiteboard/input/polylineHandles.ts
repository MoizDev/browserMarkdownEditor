import type { NodeSetOp } from '../change/ops';
import { preparePolylineControl, type PolylineControlPreview } from '../geom/polylineControls';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export interface PolylineHandleOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly index: number;
    readonly insert?: boolean;
    readonly current: () => boolean;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly show: (ops: readonly NodeSetOp[]) => void;
    readonly clear: () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

/** Direct endpoint editing preserves an attachment unless the user explicitly detaches it. */
export function polylineHandleGesture(first: RealSample, modifiers: Modifiers, options: PolylineHandleOptions): GestureOwner {
    const release = options.hold(), pointerIds = new Set([first.pointerId]);
    let sample = first, keys = modifiers, sequence = 0, ended = false, cleaned = false;
    let controller: AbortController | undefined, preview: PolylineControlPreview | undefined, unregister: (() => void) | undefined;
    const cleanup = () => {
        if (cleaned) return; cleaned = true; controller?.abort();
        try { preview?.release(); } finally { try { options.clear(); } finally { try { unregister?.(); } finally { release(); } } }
    };
    const cancel = () => { if (cleaned) return; ended = true; sequence++; cleanup(); };
    try { unregister = options.registerPending(cancel); } catch (error) { release(); throw error; }
    const render = async (commit: boolean) => {
        const turn = ++sequence, point = { x: sample.x, y: sample.y }, detach = keys.accel;
        controller?.abort(); controller = new AbortController(); const request = controller;
        preview?.release(); preview = undefined;
        let result: PolylineControlPreview | undefined;
        try {
            result = await preparePolylineControl({ runtime: options.runtime, id: options.id,
                action: options.insert ? { kind: 'insert', index: options.index, point }
                    : { kind: 'move', index: options.index, point, detach }, signal: request.signal,
                current: () => !cleaned && options.current() && turn === sequence, cooperate: options.cooperate });
            if (cleaned || request.signal.aborted || turn !== sequence) return;
            if (!options.current()) { cancel(); return; }
            if (commit) { result.commit(); result = undefined; cleanup(); }
            else { preview = result; result = undefined; options.show(preview.ops); }
        } catch (error) {
            if (!cleaned && !request.signal.aborted && turn === sequence) { try { options.error(error); } finally { cancel(); } }
        } finally { result?.release(); }
    };
    void render(false);
    return {
        kind: 'node-edit', pointerIds,
        update(samples, next) {
            if (ended || cleaned) return;
            if (!options.current()) { cancel(); return; }
            keys = next; for (const value of samples) if (pointerIds.has(value.pointerId)) sample = value;
            void render(false);
        },
        finish(reason: FinishReason) {
            if (ended || cleaned) return;
            if (reason !== 'up' || !options.current()) { cancel(); return; }
            ended = true; void render(true);
        },
        cancel(_reason: CancelReason) { cancel(); },
    };
}
