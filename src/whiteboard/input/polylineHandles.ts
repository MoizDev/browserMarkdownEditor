import type { Op } from '../change/ops';
import { prepareNotebookTransform } from './notebookTranslation';
import { preparePolylineControl, type PolylineControlPreview } from '../geom/polylineControls';
import { snapBoardBounds, type BoardSnapGuide } from '../geom/runtimeSnap';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';
import { isCancellation } from '../../platform/workers/envelope';

export interface PolylineHandleOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly index: number;
    readonly insert?: boolean;
    readonly onFinishUp?: () => void;
    readonly onCommit?: () => void;
    readonly snap?: { readonly zoom: () => number; readonly alwaysSnap: () => boolean; readonly guides: (guides: readonly BoardSnapGuide[]) => void };
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

/** Direct endpoint editing preserves an attachment unless the user explicitly detaches it. */
export function polylineHandleGesture(first: RealSample, modifiers: Modifiers, options: PolylineHandleOptions): GestureOwner {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), release = options.hold(), pointerIds = new Set([first.pointerId]);
    let sample = first, keys = modifiers, sequence = 0, ended = false, cleaned = false;
    const current = () => !cleaned && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && runtime.selection.getSnapshot() === selection;
    let controller: AbortController | undefined, preview: PolylineControlPreview | undefined, unregister: (() => void) | undefined;
    const cleanup = () => {
        if (cleaned) return; cleaned = true; controller?.abort();
        try { preview?.release(); } finally {
            try { options.snap?.guides([]); } finally { try { options.clear(); } finally { try { unregister?.(); } finally { release(); } } }
        }
    };
    const cancel = () => { if (cleaned) return; ended = true; sequence++; cleanup(); };
    try { unregister = options.registerPending(cancel); } catch (error) { release(); throw error; }
    const render = async (commit: boolean) => {
        const turn = ++sequence, raw = { x: sample.x, y: sample.y }, detach = keys.accel;
        controller?.abort(); controller = new AbortController(); const request = controller;
        preview?.release(); preview = undefined;
        let result: PolylineControlPreview | undefined;
        try {
            let point = raw, guides: readonly BoardSnapGuide[] = [];
            const active = () => current() && !request.signal.aborted && turn === sequence;
            if (options.snap && options.snap.alwaysSnap() !== detach) {
                const snapped = await snapBoardBounds({ runtime, bounds: { x: raw.x, y: raw.y, width: 0, height: 0 }, selected: [options.id],
                    zoom: options.snap.zoom(), current: active, signal: request.signal, cooperate: options.cooperate });
                if (!active()) throw new DOMException('Polyline snap became stale', 'AbortError');
                point = { x: raw.x + snapped.delta.x, y: raw.y + snapped.delta.y }; guides = snapped.guides;
            }
            result = await preparePolylineControl({ runtime, id: options.id,
                action: options.insert ? { kind: 'insert', index: options.index, point }
                    : { kind: 'move', index: options.index, point, detach }, signal: request.signal,
                current: active, cooperate: options.cooperate });
            if (cleaned || request.signal.aborted || turn !== sequence) return;
            if (!current()) { cancel(); return; }
            options.snap?.guides(guides);
            if (commit) {
                const notebook = result.ops.length ? await prepareNotebookTransform({ runtime, ids: [options.id], preview: result,
                    signal: request.signal, current: active, cooperate: options.cooperate }) : null;
                try {
                    options.show(notebook?.ops ?? result.ops); await options.waitUntilReady(request.signal);
                    if (cleaned || request.signal.aborted || turn !== sequence) return;
                    if (!current()) { cancel(); return; }
                    options.armCommit();
                    try {
                        if (notebook) { const applied = runtime.session.apply({ origin: 'tool', label: 'Edit polyline', ops: notebook.ops }); applied.release(); result.release(); }
                        else result.commit();
                        result = undefined; options.finishCommit(); options.onCommit?.();
                    } catch (error) { options.cancelCommit(); throw error; }
                    cleanup();
                } finally { notebook?.release(); }
            } else { preview = result; result = undefined; options.show(preview.ops); }
        } catch (error) {
            if (!cleaned && !request.signal.aborted && turn === sequence) {
                try { if (current() && !isCancellation(error)) options.error(error); } finally { cancel(); }
            }
        } finally { result?.release(); }
    };
    void render(false);
    return {
        kind: 'node-edit', pointerIds,
        update(samples, next) {
            if (ended || cleaned) return;
            if (!current()) { cancel(); return; }
            keys = next; for (const value of samples) if (pointerIds.has(value.pointerId)) sample = value;
            void render(false);
        },
        finish(reason: FinishReason) {
            if (ended || cleaned) return;
            if (reason !== 'up' || !current()) { cancel(); return; }
            options.onFinishUp?.(); ended = true; void render(true);
        },
        cancel(_reason: CancelReason) { cancel(); },
    };
}
