import { isLocked } from '../change/commands';
import { poseInParent, worldPose, worldToLocal, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp, Op } from '../change/ops';
import { prepareNotebookTransform } from './notebookTranslation';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import { boardSnapGrid, nearestBoardGridCoordinate } from '../geom/gridSnap';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Attachment } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { AttachmentRequest } from '../viewer/attachments';
import { bindingSegments, type BindingSegment } from '../viewer/connectorHints';
import { BindingPrecision, PRECISE_HOLD_MS } from './bindingPrecision';
import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export interface ConnectorEndHandleOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly terminal: 'start' | 'end';
    readonly current: () => boolean;
    readonly sampleToSurface: (sample: RealSample) => { readonly x: number; readonly y: number };
    readonly resolveAttachment: (point: { x: number; y: number }, signal: AbortSignal, request?: AttachmentRequest) => Promise<Attachment | null>;
    readonly hint?: (target: NodeId | null) => void;
    readonly binding?: (segments: readonly BindingSegment[] | null) => void;
    readonly show: (ops: readonly Op[]) => void;
    readonly waitUntilReady: (signal: AbortSignal) => Promise<void>;
    readonly armCommit: () => void;
    readonly finishCommit: () => void;
    readonly cancelCommit: () => void;
    readonly clear: () => void;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

/** Shift holds a free end at 15° steps from the other end (catalogue §7 a.4: the reference is the adjacent handle). */
const ANGLE_STEP = Math.PI / 12;

/** An endpoint drag is the explicit binding gesture; unrelated transforms keep bindings. */
export function connectorEndHandleGesture(first: RealSample, modifiers: Modifiers, options: ConnectorEndHandleOptions): GestureOwner {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), node = doc.nodes.get(options.id), controller = new AbortController();
    if (!node || node.kind !== 'connector' || isLocked(doc, node) || session.isReadOnly) throw new Error('Connector endpoint is not editable');
    const otherTerminal = options.terminal === 'start' ? 'end' : 'start', otherEnd = node[otherTerminal].attach;
    let sample = first, keys = modifiers, generation = 0, ended = false, cleaned = false;
    let lastSurface = options.sampleToSurface(first), moved = false, lastAt = performance.now(), speed = Number.POSITIVE_INFINITY;
    const downSurface = lastSurface;
    const precision = new BindingPrecision(PRECISE_HOLD_MS, lastAt);
    let request: AbortController | undefined, scope: BoardGeometryScope | undefined, unregister: (() => void) | undefined;
    let font: number | undefined, wake: ReturnType<typeof setTimeout> | undefined;
    const release = options.hold();
    const current = () => !controller.signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && runtime.selection.getSnapshot() === selection && (font === undefined || runtime.render.text.fonts.epoch === font);
    const cleanup = () => {
        if (cleaned) return; cleaned = true; clearTimeout(wake); wake = undefined; options.hint?.(null); options.binding?.(null);
        try { options.clear(); } finally { try { scope?.release(); } finally { try { unregister?.(); } finally { release(); } } }
    };
    const cancel = () => { if (cleaned) return; ended = true; generation++; controller.abort(); request?.abort(); cleanup(); };
    try { unregister = options.registerPending(cancel); } catch (error) { release(); throw error; }
    const source = acquireBoardGeometryScope(runtime, [node.id], { signal: controller.signal, current }).then(prepared => {
        if (controller.signal.aborted) { prepared.release(); throw new DOMException('Connector handle ended', 'AbortError'); }
        scope = prepared; font = runtime.render.text.fonts.epoch; return prepared;
    });
    const render = async (commit: boolean) => {
        const turn = ++generation; request?.abort(); const localRequest = new AbortController(); request = localRequest;
        const point = sample, input = keys, now = performance.now();
        const active = () => current() && !localRequest.signal.aborted && turn === generation;
        const check = () => { localRequest.signal.throwIfAborted(); if (!active()) throw new DOMException('Connector handle became stale', 'AbortError'); };
        let preview: BoardGeometryScope | undefined, final: BoardGeometryScope | undefined;
        try {
            if (!scope) await source;
            check();
            // Ctrl on macOS and Cmd anywhere are the no-binding keys; the free end then moves as an ordinary point.
            const bindable = !input.accel && !input.control;
            const attachment = bindable ? await options.resolveAttachment(point, localRequest.signal,
                { precise: target => precision.decide(target, now, speed, otherEnd?.target === target && otherEnd.precise),
                    exact: input.alt, route: node.route, input: point.source === 'keyboard' ? 'mouse' : point.source }) : null;
            check();
            if (!attachment) precision.leave(now);
            // Two ends on one shape at one precise anchor would be a zero-length arrow: this end steps 0.05 along x and is precise.
            options.hint?.(attachment?.target ?? null);
            const duplicate = !!attachment && otherEnd?.target === attachment.target && otherEnd.anchor.x === attachment.anchor.x && otherEnd.anchor.y === attachment.anchor.y;
            const bound = duplicate ? { ...attachment!, precise: true, anchor: { x: attachment!.anchor.x + 0.05 <= 1 ? attachment!.anchor.x + 0.05 : attachment!.anchor.x - 0.05, y: attachment!.anchor.y } } : attachment;
            let target = { x: point.x, y: point.y };
            if (!bound) {
                // Free ends follow the grid when grid mode is on and nothing else: they never snap to objects (catalogue a.3, a.4).
                if (input.shift) {
                    const reference = runtime.render.changeGeometry.resolvedTip(doc, node, otherTerminal);
                    const dx = target.x - reference.x, dy = target.y - reference.y, length = Math.hypot(dx, dy);
                    const angle = Math.round(Math.atan2(dy, dx) / ANGLE_STEP) * ANGLE_STEP;
                    target = { x: reference.x + length * Math.cos(angle), y: reference.y + length * Math.sin(angle) };
                }
                const grid = boardSnapGrid(doc);
                if (grid) {
                    const gx = nearestBoardGridCoordinate(target.x, grid.origin.x, grid.step.x), gy = nearestBoardGridCoordinate(target.y, grid.origin.y, grid.step.y);
                    target = { x: gx.coordinateRepresentable ? gx.coordinate : target.x, y: gy.coordinateRepresentable ? gy.coordinate : target.y };
                }
            }
            const local = worldToLocal(doc, node, target), terminal = options.terminal;
            const ops: NodeSetOp[] = [{ t: 'set', id: node.id, key: terminal, value: { x: local.x, y: local.y, attach: bound ?? null } }];
            const candidate = await projectBoardGeometrySets(doc, ops, { signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            preview = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            // The bound ends' stubs follow the drag: they are read from the candidate's geometry, not the committed one. A failed read
            // only leaves the stub where it was; staleness is still checked right after.
            const live = candidate.nodes.get(node.id);
            if (live?.kind === 'connector') {
                const prepared = await runtime.render.prepareForPick(live, localRequest.signal, candidate).catch(() => null); check();
                if (prepared?.connector) options.binding?.(bindingSegments(live, prepared.connector));
            }
            const bounds = preview.logicalBounds(node.id), pose = worldPose(candidate, node.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, side) => runtime.render.changeGeometry.resolvedTip(d, connector, side),
                worldBoundsCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) };
            const placement = poseInParent(doc, node, node.parent, pose, geometry);
            if (placement.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
            if (placement.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: placement.x });
            if (placement.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: placement.y });
            const finalDoc = await projectBoardGeometrySets(doc, ops, { signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            final = await acquireBoardGeometryScope(runtime, [node.id], { doc: finalDoc, signal: localRequest.signal, current: active, cooperate: options.cooperate }); check();
            // A precise end that waits out its hold needs no pointer event to become precise: wake the drag when it is due.
            const wait = commit ? null : precision.wakeIn(now);
            if (wait !== null) {
                clearTimeout(wake);
                wake = setTimeout(() => { wake = undefined; if (!ended && !cleaned && current()) void render(false); }, wait);
            }
            if (commit) {
                const notebook = await prepareNotebookTransform({ runtime, ids: [node.id], preview: { doc: finalDoc, ops },
                    signal: localRequest.signal, current: active, cooperate: options.cooperate });
                try {
                    const finalOps = notebook?.ops ?? ops;
                    options.show(finalOps); await options.waitUntilReady(localRequest.signal); check();
                    options.armCommit();
                    try { const applied = session.apply({ origin: 'tool', label: 'Move connector endpoint', ops: finalOps }); applied.release(); options.finishCommit(); }
                    catch (error) { options.cancelCommit(); throw error; }
                    ended = true; controller.abort(); cleanup();
                } finally { notebook?.release(); }
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
            keys = next;
            const before = lastSurface;
            for (const value of samples) if (value.pointerId === first.pointerId) {
                const surface = options.sampleToSurface(value);
                if (Math.hypot(surface.x - downSurface.x, surface.y - downSurface.y) >= 4) moved = true;
                lastSurface = surface; sample = value;
            }
            // Speed is the pointer's travel since the last event, in CSS px per ms: the gate that makes a slow entry precise.
            const at = performance.now();
            speed = Math.hypot(lastSurface.x - before.x, lastSurface.y - before.y) / Math.max(1, at - lastAt); lastAt = at;
            void render(false);
        },
        finish(reason: FinishReason) { if (ended) return; if (reason !== 'up' || !current() || !moved) { cancel(); return; } ended = true; void render(true); },
        cancel(_reason: CancelReason) { cancel(); },
    };
}
