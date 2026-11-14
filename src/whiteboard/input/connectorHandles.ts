import { isLocked } from '../change/commands';
import { poseInParent, worldPose, worldToLocal, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Attachment } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { AttachmentRequest } from '../viewer/attachments';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export interface ConnectorEndHandleOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly terminal: 'start' | 'end';
    readonly current: () => boolean;
    readonly sampleToSurface: (sample: RealSample) => { readonly x: number; readonly y: number };
    readonly resolveAttachment: (point: { x: number; y: number }, signal: AbortSignal, request?: AttachmentRequest) => Promise<Attachment | null>;
    readonly show: (ops: readonly NodeSetOp[]) => void;
    readonly clear: () => void;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

/** An endpoint drag is the explicit binding gesture; unrelated transforms keep bindings. */
export function connectorEndHandleGesture(first: RealSample, modifiers: Modifiers, options: ConnectorEndHandleOptions): GestureOwner {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), node = doc.nodes.get(options.id), controller = new AbortController();
    if (!node || node.kind !== 'connector' || isLocked(doc, node) || session.isReadOnly) throw new Error('Connector endpoint is not editable');
    let sample = first, keys = modifiers, generation = 0, ended = false, cleaned = false, lastMovedAt = first.time;
    let lastSurface = options.sampleToSurface(first);
    let request: AbortController | undefined, scope: BoardGeometryScope | undefined, unregister: (() => void) | undefined;
    let font: number | undefined;
    const release = options.hold();
    const current = () => !controller.signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && runtime.selection.getSnapshot() === selection && (font === undefined || runtime.render.text.fonts.epoch === font);
    const cleanup = () => {
        if (cleaned) return; cleaned = true;
        try { options.clear(); } finally { try { scope?.release(); } finally { try { unregister?.(); } finally { release(); } } }
    };
    const cancel = () => { if (cleaned) return; ended = true; generation++; controller.abort(); request?.abort(); cleanup(); };
    try { unregister = options.registerPending(cancel); } catch (error) { release(); throw error; }
    const source = acquireBoardGeometryScope(runtime, [node.id], { signal: controller.signal, current, cooperate: options.cooperate }).then(prepared => {
        if (controller.signal.aborted) { prepared.release(); throw new DOMException('Connector handle ended', 'AbortError'); }
        scope = prepared; font = runtime.render.text.fonts.epoch; return prepared;
    });
    const render = async (commit: boolean) => {
        const turn = ++generation; request?.abort(); const localRequest = new AbortController(); request = localRequest;
        const point = sample, input = keys;
        const active = () => current() && !localRequest.signal.aborted && turn === generation;
        const check = () => { localRequest.signal.throwIfAborted(); if (!active()) throw new DOMException('Connector handle became stale', 'AbortError'); };
        let preview: BoardGeometryScope | undefined, final: BoardGeometryScope | undefined;
        try {
            if (!scope) await source;
            check();
            const attachment = input.accel ? null : await options.resolveAttachment(point, localRequest.signal,
                { precise: input.shift || point.time - lastMovedAt >= 1000, exact: input.alt,
                    input: point.source === 'keyboard' ? 'mouse' : point.source });
            check();
            const local = worldToLocal(doc, node, point), terminal = options.terminal;
            const ops: NodeSetOp[] = [{ t: 'set', id: node.id, key: terminal, value: { x: local.x, y: local.y, attach: attachment } }];
            const candidate = await projectBoardGeometrySets(doc, ops, { signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            preview = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            const bounds = preview.logicalBounds(node.id), pose = worldPose(candidate, node.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, side) => runtime.render.changeGeometry.resolvedTip(d, connector, side),
                worldBoundsCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) };
            const placement = poseInParent(doc, node, node.parent, pose, geometry);
            if (placement.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
            if (placement.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: placement.x });
            if (placement.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: placement.y });
            const finalDoc = await projectBoardGeometrySets(doc, ops, { signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            final = await acquireBoardGeometryScope(runtime, [node.id], { doc: finalDoc, signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            if (commit) {
                const applied = session.apply({ origin: 'tool', label: 'Move connector endpoint', ops }); applied.release();
                ended = true; controller.abort(); cleanup();
            } else options.show(ops);
        } catch (error) {
            if (!cleaned && !localRequest.signal.aborted && turn === generation) {
                try { if (current()) options.error(error); } finally { cancel(); }
            }
        } finally { try { final?.release(); } finally { preview?.release(); } }
    };
    void render(false);
    return {
        kind: 'node-edit', pointerIds: new Set([first.pointerId]),
        update(samples, next) {
            if (ended || !current()) { if (!ended) cancel(); return; }
            keys = next; for (const value of samples) if (value.pointerId === first.pointerId) {
                const surface = options.sampleToSurface(value);
                if (surface.x !== lastSurface.x || surface.y !== lastSurface.y) lastMovedAt = value.time;
                lastSurface = surface; sample = value;
            }
            void render(false);
        },
        finish(reason: FinishReason) { if (ended) return; if (reason !== 'up' || !current()) { cancel(); return; } ended = true; void render(true); },
        cancel(_reason: CancelReason) { cancel(); },
    };
}
