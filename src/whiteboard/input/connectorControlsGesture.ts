import type { NodeSetOp } from '../change/ops';
import { prepareConnectorControl, type ConnectorControl, type ConnectorControlPreview } from '../geom/connectorControls';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export interface ConnectorControlGestureOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly control: ConnectorControl;
    readonly current: () => boolean;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly show: (ops: readonly NodeSetOp[]) => void;
    readonly clear: () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

/** Control previews are derived from the original revision; only the last request can commit. */
export function connectorControlGesture(first: RealSample, _modifiers: Modifiers, options: ConnectorControlGestureOptions): GestureOwner {
    const release = options.hold(), pointerIds = new Set([first.pointerId]);
    let sample = first, sequence = 0, ended = false, cleaned = false;
    let controller: AbortController | undefined, preview: ConnectorControlPreview | undefined, unregister: (() => void) | undefined;
    const cleanup = () => {
        if (cleaned) return; cleaned = true; controller?.abort();
        try { preview?.release(); } finally { try { options.clear(); } finally { try { unregister?.(); } finally { release(); } } }
    };
    const cancel = () => { if (cleaned) return; ended = true; sequence++; cleanup(); };
    try { unregister = options.registerPending(cancel); } catch (error) { release(); throw error; }
    const render = async (commit: boolean) => {
        const turn = ++sequence, point = { x: sample.x, y: sample.y };
        controller?.abort(); controller = new AbortController(); const request = controller;
        preview?.release(); preview = undefined;
        let result: ConnectorControlPreview | undefined;
        try {
            result = await prepareConnectorControl({ runtime: options.runtime, id: options.id, control: options.control,
                point, signal: request.signal, current: () => !cleaned && options.current() && turn === sequence,
                cooperate: options.cooperate });
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
        update(samples) {
            if (ended || cleaned) return;
            if (!options.current()) { cancel(); return; }
            for (const next of samples) if (pointerIds.has(next.pointerId)) sample = next;
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
