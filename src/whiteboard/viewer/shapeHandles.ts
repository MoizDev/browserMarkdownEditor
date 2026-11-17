import { worldToSurface } from '../../platform/render/camera';
import { cameraChanged, forgetCamera } from './cameraCache';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ViewState } from '../../platform/types';
import { isLocked } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { connectorBody, connectorBodyPoint } from '../geom/connectors';
import type { ConnectorControl } from '../geom/connectorControls';
import type { Vec2 } from '../geom/path';
import type { BoardSnapGuide } from '../geom/runtimeSnap';
import { resolvePolylineAttachments } from '../geom/polylineAttachments';
import { polylinePath } from '../geom/polylines';
import { preparePolylineControl } from '../geom/polylineControls';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { BoardRuntime } from '../host/runtime';
import { connectorEndHandleGesture } from '../input/connectorHandles';
import { connectorControlGesture } from '../input/connectorControlsGesture';
import { toggleConnectorHead } from '../input/connectorHead';
import { PresentedHistory } from '../input/presentedHistory';
import { polylineHandleGesture } from '../input/polylineHandles';
import type { GestureOwner, Modifiers, RealSample } from '../input/tool';
import type { NodeId } from '../model/ids';
import type { AttachmentRequest } from './attachments';
import type { Attachment } from '../model/nodes';
import type { Op } from '../change/ops';

export type ShapeHandleHit = Readonly<{ kind: 'connector-end'; terminal: 'start' | 'end' }>
    | Readonly<{ kind: 'connector-control'; control: ConnectorControl }>
    | Readonly<{ kind: 'polyline-vertex'; index: number }>
    | Readonly<{ kind: 'polyline-midpoint'; index: number }>;
export interface ShapeHandleOptions {
    readonly runtime: BoardRuntime;
    readonly overlay: HTMLElement;
    readonly view: () => ViewState;
    readonly current: () => boolean;
    readonly visible: () => boolean;
    readonly sampleToSurface: (sample: RealSample) => Vec2;
    readonly alwaysSnap: () => boolean;
    readonly guides: (guides: readonly BoardSnapGuide[]) => void;
    readonly invalidate: () => void;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly show: (ops: readonly Op[]) => void;
    readonly waitUntilReady: (signal: AbortSignal) => Promise<void>;
    readonly waitUntilIdle: (signal: AbortSignal) => Promise<void>;
    readonly armCommit: () => void;
    readonly finishCommit: () => void;
    readonly cancelCommit: () => void;
    readonly clear: () => void;
    readonly resolveAttachment: (point: Vec2, signal: AbortSignal, request?: AttachmentRequest) => Promise<Attachment | null>;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}
type Handle = { readonly hit: ShapeHandleHit; readonly point: Vec2 };

/** Shape handles borrow current canonical geometry and never infer endpoint positions from b. */
export function createShapeHandles(options: ShapeHandleOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    let handles: readonly Handle[] = [], selected: NodeId | null = null, generation = 0, disposed = false;
    let controller: AbortController | undefined, svg: SVGSVGElement | undefined, group: SVGGElement | undefined;
    // The group's translation in surface pixels, as last written: a drag's offset moves every handle by one transform.
    let groupX = Number.NaN, groupY = Number.NaN;
    let rendered: readonly Handle[] | null = null, renderedCount = 0;
    // The camera the group was built for: x, y, z as numbers, NaN until built.
    const renderedCamera = new Float64Array(3).fill(Number.NaN);
    const presented = new PresentedHistory<{ camera: ViewState['camera']; handles: readonly Handle[]; count: number }>();
    let controlPending: AbortController | undefined, headBusy = false;
    const current = () => !disposed && options.current() && options.visible() && session.doc === doc;
    const clear = () => { handles = []; selected = null; svg?.remove(); svg = undefined; group = undefined;
        rendered = null; renderedCount = 0; forgetCamera(renderedCamera); presented.clear(); options.invalidate(); };
    const refresh = () => {
        const turn = ++generation; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
        clear(); if (!current()) return;
        const state = runtime.selection.getSnapshot(), revision = doc.rev, owner = session.owner;
        if (state.selected.length !== 1) return;
        const node = doc.nodes.get(state.selected[0]);
        if (!node || (node.kind !== 'polyline' && node.kind !== 'connector') || isLocked(doc, node)) return;
        const active = () => !signal.aborted && turn === generation && current() && session.owner === owner && doc.rev === revision
            && runtime.selection.getSnapshot() === state;
        void (async () => {
            const scope = await acquireBoardGeometryScope(runtime, [node.id], { signal, current: active, cooperate: options.cooperate });
            try {
                if (!active()) return;
                const next: Handle[] = [];
                if (node.kind === 'polyline') {
                    const actual = await resolvePolylineAttachments(node, { runtime, signal, current: active, cooperate: options.cooperate });
                    try {
                        const pose = worldPose(doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                        const world = (p: Vec2) => ({ x: pose.x + c * p.x - s * p.y, y: pose.y + s * p.x + c * p.y });
                        for (let index = 0; index < actual.points.length; index++) {
                            next.push({ hit: { kind: 'polyline-vertex', index }, point: world(actual.points[index]) });
                            if ((index & 127) === 127) {
                                await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
                                if (!active()) return;
                            }
                        }
                        const path = polylinePath({ ...node, points: actual.points });
                        for (let index = 1; index < path.length; index++) {
                            const segment = path[index], a = actual.points[index - 1];
                            let p: Vec2;
                            if (segment.op === 'L') p = { x: (a.x + segment.p.x) / 2, y: (a.y + segment.p.y) / 2 };
                            else if (segment.op === 'C') p = { x: (a.x + 3 * segment.c1.x + 3 * segment.c2.x + segment.p.x) / 8,
                                y: (a.y + 3 * segment.c1.y + 3 * segment.c2.y + segment.p.y) / 8 };
                            else continue;
                            next.push({ hit: { kind: 'polyline-midpoint', index }, point: world(p) });
                            if ((index & 127) === 127) {
                                await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
                                if (!active()) return;
                            }
                        }
                    } finally { actual.release(); }
                } else {
                    const prepared = await runtime.render.prepareForPick(node, signal, doc);
                    const geometry = prepared.connector; if (!geometry) throw new Error('Connector geometry is unavailable');
                    next.push({ hit: { kind: 'connector-end', terminal: 'start' }, point: geometry.start.tipWorld },
                        { hit: { kind: 'connector-end', terminal: 'end' }, point: geometry.end.tipWorld });
                    const a = geometry.start.aimWorld, b = geometry.end.aimWorld;
                    if (node.route === 'elbow') {
                        // Default, calibration cut by owner: the dominant axis exposes the elbow midpoint.
                        const t = node.elbowMid, p = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
                            ? { x: a.x * (1 - t) + b.x * t, y: (a.y + b.y) / 2 }
                            : { x: (a.x + b.x) / 2, y: a.y * (1 - t) + b.y * t };
                        next.push({ hit: { kind: 'connector-control', control: 'elbow' }, point: p });
                    } else {
                        const metric = styleGeometryMetrics.bendThreshold(node.size, node.width);
                        const threshold = metric.status === 'bracket' ? metric.min : metric.status === 'provisional' ? metric.value : node.width * 3;
                        const body = connectorBody(a, b, Math.abs(node.bend) <= threshold ? 0 : node.bend, 0.01);
                        next.push({ hit: { kind: 'connector-control', control: 'bend' }, point: connectorBodyPoint(body, .5) });
                    }
                    if (node.label) next.push({ hit: { kind: 'connector-control', control: 'label' }, point: geometry.editMetrics.anchorWorld });
                }
                if (!active()) return; selected = node.id; handles = Object.freeze(next); options.invalidate();
            } finally { scope.release(); }
        })().catch(error => { if (active()) options.error(error); });
    };
    const stopSelection = runtime.selection.subscribe(refresh), stopSession = session.subscribe(refresh);
    refresh();
    // The handles are built once per camera, in surface pixels, and a drag's translation moves them all as one group transform:
    // a moving translation rebuilds no node, it writes one attribute when its offset changed. By reading: the frame left them
    // at rest while the preview moved, and a rebuild per move would cost a node per handle of a large polyline.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const paint = (camera: ViewState['camera'], moving: Vec2 | null): boolean => {
        if (!svg || !group) {
            svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
            group = document.createElementNS(SVG_NS, 'g'); svg.append(group); options.overlay.append(svg);
            rendered = null; renderedCount = 0; groupX = Number.NaN; groupY = Number.NaN;
        }
        // Checked first and unconditionally, so the cache tracks the camera even on a frame rebuilt for the handles alone.
        const cameraMoved = cameraChanged(renderedCamera, camera);
        if (rendered !== handles || cameraMoved) {
            group.replaceChildren(); rendered = handles; renderedCount = 0;
        }
        // A large imported polyline cannot rebuild thousands of SVG commands in one frame.
        const limit = Math.min(handles.length, renderedCount + 1024);
        while (renderedCount < limit) {
            const path = document.createElementNS(SVG_NS, 'path'), parts: string[] = [];
            const end = Math.min(limit, renderedCount + 256);
            while (renderedCount < end) {
                const handle = handles[renderedCount++], p = worldToSurface(handle.point, camera);
                const r = handle.hit.kind === 'connector-control' || handle.hit.kind === 'polyline-midpoint' ? 3 : 5;
                parts.push(`M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`);
            }
            path.setAttribute('d', parts.join(' ')); path.setAttribute('fill', '#ffffff');
            path.setAttribute('stroke', '#75b7ff'); path.setAttribute('stroke-width', '1.5'); group.append(path);
        }
        const dx = moving ? moving.x * camera.z : 0, dy = moving ? moving.y * camera.z : 0;
        if (dx !== groupX || dy !== groupY) {
            groupX = dx; groupY = dy;
            if (dx || dy) group.setAttribute('transform', `translate(${dx} ${dy})`); else group.removeAttribute('transform');
        }
        return renderedCount >= handles.length;
    };
    return {
        refresh,
        hit(surface: Vec2, coarse = false, time?: number): ShapeHandleHit | null {
            if (!current() || ![surface.x, surface.y].every(Number.isFinite)) return null;
            const state = presented.at(time), radius = coarse ? 16 : 7;
            if (!state || state.handles !== handles) return null;
            const camera = state.camera;
            for (let index = 0; index < state.count; index++) {
                const handle = handles[index], p = worldToSurface(handle.point, camera);
                if (Math.hypot(surface.x - p.x, surface.y - p.y) <= radius) return handle.hit;
            }
            return null;
        },
        begin(hit: ShapeHandleHit, sample: RealSample, modifiers: Modifiers): GestureOwner | null {
            if (!current() || !selected) return null;
            const common = { runtime, id: selected, current, hold: options.hold, registerPending: options.registerPending,
                show: options.show, waitUntilReady: options.waitUntilReady, armCommit: options.armCommit,
                finishCommit: options.finishCommit, cancelCommit: options.cancelCommit,
                clear: options.clear, error: options.error, cooperate: options.cooperate };
            const snap = { zoom: () => options.view().camera.z, alwaysSnap: options.alwaysSnap, guides: options.guides };
            if (hit.kind === 'polyline-vertex' || hit.kind === 'polyline-midpoint') return polylineHandleGesture(sample, modifiers,
                { ...common, index: hit.index, insert: hit.kind === 'polyline-midpoint', snap });
            if (hit.kind === 'connector-end') return connectorEndHandleGesture(sample, modifiers, { ...common, terminal: hit.terminal, snap,
                sampleToSurface: options.sampleToSurface, resolveAttachment: options.resolveAttachment });
            return connectorControlGesture(sample, modifiers, { ...common, control: hit.control, zoom: () => options.view().camera.z });
        },
        toggleHead(hit: ShapeHandleHit): boolean {
            if (!current() || !selected || hit.kind !== 'connector-end') return false;
            if (headBusy || controlPending) return true;
            return toggleConnectorHead({ runtime, id: selected, terminal: hit.terminal, current,
                hold: () => { const release = options.hold(); headBusy = true; return () => { headBusy = false; release(); }; },
                registerPending: options.registerPending, show: options.show, waitUntilIdle: options.waitUntilIdle,
                waitUntilReady: options.waitUntilReady, armCommit: options.armCommit, finishCommit: options.finishCommit,
                cancelCommit: options.cancelCommit, clear: options.clear, error: options.error, cooperate: options.cooperate });
        },
        remove(hit: ShapeHandleHit): boolean {
            if (!current() || !selected || hit.kind !== 'polyline-vertex') return false;
            const node = doc.nodes.get(selected);
            if (!node || node.kind !== 'polyline') return false;
            if (node.points.length <= 2) { options.error(new Error('A line must retain at least two vertices')); return true; }
            if (controlPending) return true;
            const id = node.id, request = new AbortController(), release = options.hold();
            const revision = doc.rev, owner = session.owner, selection = runtime.selection.getSnapshot();
            const active = () => !request.signal.aborted && current() && session.owner === owner && doc.rev === revision
                && runtime.selection.getSnapshot() === selection;
            controlPending = request; let unregister: (() => void) | undefined;
            try { unregister = options.registerPending(() => request.abort()); }
            catch (error) { controlPending = undefined; release(); throw error; }
            void (async () => {
                await options.waitUntilIdle(request.signal);
                request.signal.throwIfAborted(); if (!active()) throw new DOMException('Polyline edit became stale', 'AbortError');
                const preview = await preparePolylineControl({ runtime, id, action: { kind: 'delete', index: hit.index },
                    current: active, signal: request.signal, cooperate: options.cooperate });
                try {
                    request.signal.throwIfAborted(); if (!active()) throw new DOMException('Polyline edit became stale', 'AbortError');
                    options.show(preview.ops); await options.waitUntilReady(request.signal);
                    request.signal.throwIfAborted(); if (!active()) throw new DOMException('Polyline edit became stale', 'AbortError');
                    options.armCommit();
                    try { preview.commit(); options.finishCommit(); }
                    catch (error) { options.cancelCommit(); throw error; }
                } finally { preview.release(); }
            })().catch(error => {
                if (!request.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) options.error(error);
            }).finally(() => {
                if (controlPending === request) controlPending = undefined;
                try { options.clear(); } finally { try { unregister?.(); } finally { release(); } }
            }).catch(options.error);
            return true;
        },
        write(frame: ScheduledFrame, moving: Vec2 | null = null) {
            if (!current() || !handles.length) { svg?.remove(); svg = undefined; group = undefined; rendered = null; renderedCount = 0; presented.clear(); return; }
            const camera = frame.view.camera;
            const complete = paint(camera, moving);
            presented.present(frame.timestamp, { camera: { ...camera }, handles, count: renderedCount });
            if (!complete) options.invalidate();
        },
        writeLive(view: ViewState, moving: Vec2 | null = null) {
            if (!current() || !handles.length) return;
            if (!paint(view.camera, moving)) options.invalidate();
        },
        hide() { generation++; controller?.abort(); controlPending?.abort(); clear(); },
        dispose() { if (disposed) return; disposed = true; generation++; controller?.abort(); controlPending?.abort(); controlPending = undefined; stopSelection(); stopSession(); svg?.remove(); svg = undefined; group = undefined; handles = []; selected = null;
            rendered = null; renderedCount = 0; presented.clear(); },
    };
}
