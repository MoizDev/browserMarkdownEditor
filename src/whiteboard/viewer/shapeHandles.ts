import { worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ViewState } from '../../platform/types';
import { isLocked } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { connectorBody, connectorBodyPoint } from '../geom/connectors';
import type { ConnectorControl } from '../geom/connectorControls';
import type { Vec2 } from '../geom/path';
import { resolvePolylineAttachments } from '../geom/polylineAttachments';
import { polylinePath } from '../geom/polylines';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { BoardRuntime } from '../host/runtime';
import { connectorEndHandleGesture } from '../input/connectorHandles';
import { connectorControlGesture } from '../input/connectorControlsGesture';
import { polylineHandleGesture } from '../input/polylineHandles';
import type { GestureOwner, Modifiers, RealSample } from '../input/tool';
import type { NodeId } from '../model/ids';
import type { AttachmentRequest } from './attachments';
import type { Attachment } from '../model/nodes';
import type { NodeSetOp } from '../change/ops';

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
    readonly invalidate: () => void;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly show: (ops: readonly NodeSetOp[]) => void;
    readonly waitUntilReady: (signal: AbortSignal) => Promise<void>;
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
    let controller: AbortController | undefined, svg: SVGSVGElement | undefined;
    const current = () => !disposed && options.current() && options.visible() && session.doc === doc;
    const clear = () => { handles = []; selected = null; svg?.remove(); svg = undefined; options.invalidate(); };
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
                        }
                        const path = polylinePath({ ...node, points: actual.points });
                        for (let index = 1; index < path.length; index++) {
                            const segment = path[index], a = actual.points[index - 1];
                            if (segment.op !== 'L' && segment.op !== 'C') continue;
                            const p = segment.op === 'L'
                                ? { x: (a.x + segment.p.x) / 2, y: (a.y + segment.p.y) / 2 }
                                : { x: (a.x + 3 * segment.c1.x + 3 * segment.c2.x + segment.p.x) / 8,
                                    y: (a.y + 3 * segment.c1.y + 3 * segment.c2.y + segment.p.y) / 8 };
                            next.push({ hit: { kind: 'polyline-midpoint', index }, point: world(p) });
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
    return {
        refresh,
        hit(surface: Vec2, coarse = false): ShapeHandleHit | null {
            if (!current() || ![surface.x, surface.y].every(Number.isFinite)) return null;
            const view = options.view(), radius = coarse ? 16 : 7;
            for (const handle of handles) {
                const p = worldToSurface(handle.point, view.camera);
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
            if (hit.kind === 'polyline-vertex' || hit.kind === 'polyline-midpoint') return polylineHandleGesture(sample, modifiers,
                { ...common, index: hit.index, insert: hit.kind === 'polyline-midpoint' });
            if (hit.kind === 'connector-end') return connectorEndHandleGesture(sample, modifiers, { ...common, terminal: hit.terminal,
                sampleToSurface: options.sampleToSurface, resolveAttachment: options.resolveAttachment });
            return connectorControlGesture(sample, modifiers, { ...common, control: hit.control });
        },
        write(frame: ScheduledFrame) {
            if (!current() || !handles.length) { svg?.remove(); svg = undefined; return; }
            if (!svg) {
                svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
                svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg);
            }
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'), parts: string[] = [];
            for (const handle of handles) {
                const p = worldToSurface(handle.point, frame.view.camera), r = handle.hit.kind === 'connector-control' || handle.hit.kind === 'polyline-midpoint' ? 3 : 5;
                parts.push(`M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`);
            }
            path.setAttribute('d', parts.join(' ')); path.setAttribute('fill', '#ffffff');
            path.setAttribute('stroke', '#75b7ff'); path.setAttribute('stroke-width', '1.5'); svg.replaceChildren(path);
        },
        hide() { generation++; controller?.abort(); clear(); },
        dispose() { if (disposed) return; disposed = true; generation++; controller?.abort(); stopSelection(); stopSession(); svg?.remove(); svg = undefined; handles = []; selected = null; },
    };
}
