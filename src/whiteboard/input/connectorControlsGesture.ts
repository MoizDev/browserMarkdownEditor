import type { Op } from '../change/ops';
import { prepareNotebookTransform } from './notebookTranslation';
import { prepareConnectorControl, type ConnectorControl, type ConnectorControlPreview } from '../geom/connectorControls';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import { CLICK_SLOP_CSS, type CancelReason, type FinishReason, type GestureOwner, type Modifiers, type RealSample } from './tool';

export const LABEL_CENTRE_SNAP_PX = 10;
const HANDLE_CENTRE_SNAP_PX = 16, HANDLE_MID_SNAP_PX = 10;

export interface ConnectorControlGestureOptions {
    readonly runtime: BoardRuntime;
    readonly zoom?: () => number;
    readonly id: NodeId;
    readonly editText?: (id: NodeId) => void | Promise<void>;
    readonly clickEdits?: boolean;
    readonly control: ConnectorControl;
    readonly current: () => boolean;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly show: (ops: readonly Op[]) => void;
    readonly waitUntilReady: (signal: AbortSignal) => Promise<void>;
    readonly armCommit: () => void;
    readonly finishCommit: () => void;
    readonly cancelCommit: () => void;
    readonly clear: () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

export function connectorControlGesture(first: RealSample, _modifiers: Modifiers, options: ConnectorControlGestureOptions): GestureOwner {
    const release = options.hold(), pointerIds = new Set([first.pointerId]);
    let sample = first, sequence = 0, ended = false, cleaned = false, moved = false;
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
            const zoom = options.zoom?.() ?? 1;
            result = await prepareConnectorControl({ runtime: options.runtime, id: options.id, control: options.control,
                point, signal: request.signal, current: () => !cleaned && options.current() && turn === sequence,
                cooperate: options.cooperate, labelSnapWorld: zoom > 0 ? LABEL_CENTRE_SNAP_PX / zoom : undefined,
                handleSnapWorld: zoom > 0 ? { centre: HANDLE_CENTRE_SNAP_PX / zoom, mid: HANDLE_MID_SNAP_PX / zoom } : undefined });
            if (cleaned || request.signal.aborted || turn !== sequence) return;
            if (!options.current()) { cancel(); return; }
            if (commit) {
                const notebook = result.ops.length ? await prepareNotebookTransform({ runtime: options.runtime, ids: [options.id], preview: result,
                    signal: request.signal, current: () => !cleaned && options.current() && turn === sequence, cooperate: options.cooperate }) : null;
                try {
                    options.show(notebook?.ops ?? result.ops); await options.waitUntilReady(request.signal);
                    if (cleaned || request.signal.aborted || turn !== sequence) return;
                    if (!options.current()) { cancel(); return; }
                    options.armCommit();
                    try {
                        if (notebook) { const applied = options.runtime.session.apply({ origin: 'tool', label: 'Edit connector', ops: notebook.ops }); applied.release(); result.release(); }
                        else result.commit();
                        result = undefined; options.finishCommit();
                    } catch (error) { options.cancelCommit(); throw error; }
                    cleanup();
                } finally { notebook?.release(); }
            } else { preview = result; result = undefined; options.show(preview.ops); }
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
            for (const next of samples) if (pointerIds.has(next.pointerId)) {
                sample = next;
                if (Math.hypot(next.x - first.x, next.y - first.y) * (options.zoom?.() ?? 1) >= CLICK_SLOP_CSS) moved = true;
            }
            void render(false);
        },
        finish(reason: FinishReason) {
            if (ended || cleaned) return;
            if (reason !== 'up' || !options.current()) { cancel(); return; }
            ended = true;
            if ((options.control === 'label' || options.clickEdits) && !moved && options.editText) { cleanup(); void options.editText(options.id); return; }
            void render(true);
        },
        cancel(_reason: CancelReason) { cancel(); },
    };
}
