import type { Op } from '../change/ops';
import { prepareNotebookTransform } from './notebookTranslation';
import { preparePolylineControl, type PolylineControlPreview } from '../geom/polylineControls';
import { snapBoardBounds, type BoardSnapGuide } from '../geom/runtimeSnap';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import { worldPose } from '../change/coordinates';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export interface PolylineHandleOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly index: number;
    readonly insert?: boolean;
    readonly onFinishUp?: () => void;
    readonly onCommit?: () => void;
    readonly snap?: { readonly zoom: () => number; readonly alwaysSnap: () => boolean; readonly guides: (guides: readonly BoardSnapGuide[]) => void };
    /** Shift constrains the point to 15° from its neighbouring vertex. The Shift-click that extends a line turns this off:
     * its point is where the pointer is, and Shift there only chose to extend. */
    readonly angleSnap?: boolean;
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

/** The point at its own distance from the neighbouring vertex, on the nearest 15° ray; null when there is no neighbour to measure from. */
function angleFromNeighbour(runtime: BoardRuntime, id: NodeId, index: number, point: Readonly<{ x: number; y: number }>): { x: number; y: number } | null {
    const doc = runtime.session.doc, node = doc.nodes.get(id);
    if (!node || node.kind !== 'polyline') return null;
    const neighbour = index > 0 ? index - 1 : index + 1, local = node.points[neighbour];
    if (!local) return null;
    const pose = worldPose(doc, id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    const anchor = { x: pose.x + c * local.x - s * local.y, y: pose.y + s * local.x + c * local.y };
    const dx = point.x - anchor.x, dy = point.y - anchor.y, length = Math.hypot(dx, dy);
    if (!(length > 0)) return null;
    const step = Math.PI / 12, angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: anchor.x + length * Math.cos(angle), y: anchor.y + length * Math.sin(angle) };
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
            if (keys.shift && options.angleSnap !== false) {
                const angled = angleFromNeighbour(runtime, options.id, options.index, point);
                if (angled) { point = angled; guides = []; }
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
                try { if (current() && !(error instanceof DOMException && error.name === 'AbortError')) options.error(error); } finally { cancel(); }
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
