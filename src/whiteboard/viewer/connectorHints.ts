import { worldPose } from '../change/coordinates';
import { worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { Affine, ViewState } from '../../platform/types';
import { transformPoint } from '../geom/affine';
import type { ConnectorGeometry } from '../geom/connectorTypes';
import type { PathOp, Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Attachment, ConnectorNode } from '../model/nodes';
import { PRECISE_HOVER_MS } from '../input/bindingPrecision';

export interface ConnectorHintOptions {
    readonly runtime: BoardRuntime;
    readonly overlay: HTMLElement;
    readonly view: () => ViewState;
    readonly current: () => boolean;
    readonly invalidate: () => void;
}
export interface BindingSegment { readonly from: Vec2; readonly to: Vec2; readonly mark: 'none' | 'cross' | 'ring' }

export function bindingSegments(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry): BindingSegment[] {
    const segments: BindingSegment[] = [];
    for (const terminal of ['start', 'end'] as const) {
        const attach = node[terminal].attach; if (!attach) continue;
        const end = geometry[terminal];
        segments.push({ from: end.boundaryWorld, to: end.aimWorld, mark: attach.exact ? 'none' : attach.precise ? 'cross' : 'ring' });
    }
    return segments;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HINT_STROKE = '#75b7ff';
const EDGE_RADIUS = 8, EDGE_POINT_RADIUS = 12, HANDLE_RADIUS = 4;
type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type Surface = { readonly outline: readonly PathOp[]; readonly localToWorld: Affine; readonly centre: Vec2; readonly box: Box };
export interface ElbowHint { readonly anchor: Vec2 | null; readonly snap: Attachment['snap'] }

function outlineBox(outline: readonly PathOp[]): Box {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const op of outline) if (op.op !== 'Z') {
        x0 = Math.min(x0, op.p.x); y0 = Math.min(y0, op.p.y); x1 = Math.max(x1, op.p.x); y1 = Math.max(y1, op.p.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function elbowHintOf(route: 'arc' | 'elbow', attachment: Readonly<Attachment> | null | undefined): ElbowHint | null {
    return route === 'elbow' && attachment && !attachment.exact ? { anchor: attachment.anchor, snap: attachment.snap } : null;
}

function elbowMarks(surface: Surface, elbow: ElbowHint | null, hover: boolean): { handles: Vec2[]; snap: { point: Vec2; kind: Attachment['snap'] } | null } {
    if (!elbow && !hover) return { handles: [], snap: null };
    const { x, y, w, h } = surface.box;
    const handles = [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
    const anchor = elbow?.anchor;
    const snap = anchor && (elbow!.snap === 'edge' || elbow!.snap === 'edge-point')
        ? { point: { x: x + anchor.x * w, y: y + anchor.y * h }, kind: elbow!.snap } : null;
    return { handles, snap };
}

export function createConnectorHints(options: ConnectorHintOptions) {
    const { runtime } = options, doc = runtime.session.doc;
    let wanted: NodeId | null = null, surface: Surface | null = null, generation = 0, disposed = false;
    let bindings: readonly BindingSegment[] | null = null;
    let elbow: ElbowHint | null = null, hoverElbow = false;
    let hoverTarget: NodeId | null = null, hoverPointer: Vec2 | null = null, hoverExact = false, hoverPrecise = false;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined, svg: SVGSVGElement | undefined, targetPath: SVGPathElement | undefined, bindingPath: SVGPathElement | undefined;
    let targetPainted = '', bindingPainted = '', bindingDash = '', dotPainted = '';
    let dotPath: SVGPathElement | undefined;
    const current = () => !disposed && options.current() && runtime.session.doc === doc;
    const ensure = () => {
        if (svg) return;
        svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
        svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
        targetPath = document.createElementNS(SVG_NS, 'path'); bindingPath = document.createElementNS(SVG_NS, 'path'); dotPath = document.createElementNS(SVG_NS, 'path');
        for (const path of [targetPath, bindingPath]) { path.setAttribute('fill', 'none'); path.setAttribute('stroke', HINT_STROKE); path.setAttribute('stroke-width', '1.5'); svg.append(path); }
        dotPath.setAttribute('fill', HINT_STROKE); dotPath.setAttribute('stroke', 'none'); svg.append(dotPath);
        options.overlay.append(svg);
    };
    const marks = (): readonly BindingSegment[] | null => {
        if (hoverTarget !== null && surface && hoverPointer && !hoverExact) {
            return hoverPrecise ? [{ from: hoverPointer, to: hoverPointer, mark: 'cross' }] : [{ from: surface.centre, to: surface.centre, mark: 'ring' }];
        }
        return bindings;
    };
    const paint = (camera: ViewState['camera']) => {
        const shown = marks();
        if (!surface && !shown?.length) { if (svg) { targetPath?.setAttribute('d', ''); bindingPath?.setAttribute('d', ''); dotPath?.setAttribute('d', ''); targetPainted = bindingPainted = dotPainted = ''; } return; }
        ensure();
        if (surface) {
            const to = (p: Vec2) => { const q = worldToSurface(transformPoint(surface!.localToWorld, p), camera); return `${q.x} ${q.y}`; };
            const parts: string[] = [];
            for (const op of surface.outline) {
                if (op.op === 'M') parts.push(`M ${to(op.p)}`);
                else if (op.op === 'L') parts.push(`L ${to(op.p)}`);
                else if (op.op === 'C') parts.push(`C ${to(op.c1)} ${to(op.c2)} ${to(op.p)}`);
                else parts.push('Z');
            }
            const dots = elbowMarks(surface, elbow, hoverElbow), at = (p: Vec2) => worldToSurface(transformPoint(surface!.localToWorld, p), camera);
            const disc = (q: Vec2, r: number) => `M ${q.x - r} ${q.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
            const ringed = dots.snap ? disc(at(dots.snap.point), dots.snap.kind === 'edge-point' ? EDGE_POINT_RADIUS : EDGE_RADIUS) : '';
            const full = ringed ? `${parts.join(' ')} ${ringed}` : parts.join(' ');
            if (full !== targetPainted) { targetPainted = full; targetPath!.setAttribute('d', full); }
            const dd = dots.handles.map(handle => disc(at(handle), HANDLE_RADIUS)).join(' ');
            if (dd !== dotPainted) { dotPainted = dd; dotPath!.setAttribute('d', dd); }
        } else if (targetPainted) { targetPainted = ''; targetPath!.setAttribute('d', ''); dotPainted = ''; dotPath!.setAttribute('d', ''); }
        if (shown?.length) {
            const at = (p: Vec2) => worldToSurface(p, camera);
            const dash = camera.z >= 0.2 ? '4 4' : '';
            const parts: string[] = [];
            for (const { from, to, mark } of shown) {
                const a = at(from), b = at(to);
                parts.push(`M ${a.x} ${a.y} L ${b.x} ${b.y}`);
                if (mark === 'ring') parts.push(`M ${b.x - 4} ${b.y} a 4 4 0 1 0 8 0 a 4 4 0 1 0 -8 0 Z`);
                else if (mark === 'cross') parts.push(`M ${b.x - 3} ${b.y - 3} L ${b.x + 3} ${b.y + 3} M ${b.x + 3} ${b.y - 3} L ${b.x - 3} ${b.y + 3}`);
            }
            const d = parts.join(' ');
            if (d !== bindingPainted) { bindingPainted = d; bindingPath!.setAttribute('d', d); }
            if (dash !== bindingDash) { bindingDash = dash; if (dash) bindingPath!.setAttribute('stroke-dasharray', dash); else bindingPath!.removeAttribute('stroke-dasharray'); }
        } else if (bindingPainted) { bindingPainted = ''; bindingPath!.setAttribute('d', ''); }
    };
    const clearHover = () => {
        clearTimeout(hoverTimer); hoverTimer = undefined; hoverTarget = null; hoverPointer = null; hoverExact = false; hoverPrecise = false;
    };
    const showTarget = (target: NodeId | null): void => {
        if (target === wanted) return;
        wanted = target; generation++; controller?.abort(); controller = undefined;
        const node = target === null ? undefined : doc.nodes.get(target);
        if (!node || node.kind === 'connector' || node.kind === 'group' || node.kind === 'opaque') { surface = null; options.invalidate(); return; }
        const turn = generation, request = new AbortController(); controller = request;
        void runtime.render.prepareForPick(node, request.signal, doc).then(prepared => {
            if (request.signal.aborted || turn !== generation || !current()) return;
            const attachments = prepared.vector?.attachments, pose = worldPose(doc, node.id);
            const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), localToWorld: Affine = [c, s, -s, c, pose.x, pose.y];
            const box = attachments ? outlineBox(attachments.outline) : null;
            surface = attachments && box ? { outline: attachments.outline, localToWorld, box, centre: transformPoint(localToWorld, { x: box.x + box.w / 2, y: box.y + box.h / 2 }) } : null;
            options.invalidate();
        }).catch(() => { if (turn === generation) { surface = null; options.invalidate(); } });
    };
    return {
        setBinding(segments: readonly BindingSegment[] | null): void { bindings = segments && segments.length ? segments : null; options.invalidate(); },
        setTarget(target: NodeId | null, elbowHint: ElbowHint | null = null): void { clearHover(); elbow = elbowHint; showTarget(target); },
        setHover(target: NodeId | null, pointer: Vec2 | null, exact: boolean, elbowRoute = false): void {
            hoverElbow = elbowRoute && !exact && target !== null;
            if (target !== hoverTarget) {
                clearTimeout(hoverTimer); hoverTimer = undefined; hoverPrecise = false; hoverTarget = target;
                if (target !== null) hoverTimer = setTimeout(() => { hoverTimer = undefined; hoverPrecise = true; options.invalidate(); }, PRECISE_HOVER_MS);
            }
            hoverPointer = target === null ? null : pointer; hoverExact = exact;
            showTarget(target); options.invalidate();
        },
        write(frame: ScheduledFrame) { if (current()) paint(frame.view.camera); },
        writeLive(view: ViewState) { if (current()) paint(view.camera); },
        dispose(): void {
            if (disposed) return; disposed = true; generation++; controller?.abort(); clearHover();
            svg?.remove(); svg = undefined; targetPath = undefined; bindingPath = undefined; dotPath = undefined; surface = null; wanted = null; bindings = null; elbow = null; hoverElbow = false;
        },
    };
}
