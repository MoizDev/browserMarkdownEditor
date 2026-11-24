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
/** One bound end's hint: a dashed stub from where the arrow meets the shape to the handle it was bound to, marked by how it binds. */
export interface BindingSegment { readonly from: Vec2; readonly to: Vec2; readonly mark: 'none' | 'cross' | 'ring' }

/** Exact draws no marker, precise a cross and an imprecise (centred) binding a ring (catalogue §7 a.9). */
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
// The selection colour the handles use, so a hint reads as part of the same overlay.
const HINT_STROKE = '#75b7ff';
// Radii in screen px (catalogue a.9, ArrowHintOverlayUtil: edge 8, edge-point 12, handle 4).
const EDGE_RADIUS = 8, EDGE_POINT_RADIUS = 12, HANDLE_RADIUS = 4;
type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type Surface = { readonly outline: readonly PathOp[]; readonly localToWorld: Affine; readonly centre: Vec2; readonly box: Box };
/** An elbow end's hint beyond the outline: where its anchor landed (a fraction of the target's box) and how it snapped. */
export interface ElbowHint { readonly anchor: Vec2 | null; readonly snap: Attachment['snap'] }

/** The box of an outline in its own space. An imprecise arrow binds to the centre of this box. */
function outlineBox(outline: readonly PathOp[]): Box {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const op of outline) if (op.op !== 'Z') {
        x0 = Math.min(x0, op.p.x); y0 = Math.min(y0, op.p.y); x1 = Math.max(x1, op.p.x); y1 = Math.max(y1, op.p.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** An elbow end's target hint: its edge dots, and the anchor's snap circle (catalogue a.9). An exact end shows no hint marks. */
export function elbowHintOf(route: 'arc' | 'elbow', attachment: Readonly<Attachment> | null | undefined): ElbowHint | null {
    return route === 'elbow' && attachment && !attachment.exact ? { anchor: attachment.anchor, snap: attachment.snap } : null;
}

/** The elbow marks in the target's own space: the four edge handles (N, E, S, W midpoints of the box) for an elbow end that is not
 * exact, and the snap circle at the anchor when the anchor landed on an edge or edge point (catalogue a.9). The hover has no anchor yet. */
function elbowMarks(surface: Surface, elbow: ElbowHint | null, hover: boolean): { handles: Vec2[]; snap: { point: Vec2; kind: Attachment['snap'] } | null } {
    if (!elbow && !hover) return { handles: [], snap: null };
    const { x, y, w, h } = surface.box;
    const handles = [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
    const anchor = elbow?.anchor;
    const snap = anchor && (elbow!.snap === 'edge' || elbow!.snap === 'edge-point')
        ? { point: { x: x + anchor.x * w, y: y + anchor.y * h }, kind: elbow!.snap } : null;
    return { handles, snap };
}

/** The arrow hints drawn over the board: the outline of the shape an arrow end would bind to (catalogue §7 a.9, the target
 * hint), the stubs of the bound ends of the selected arrow or of an end being dragged, and the arrow tool's idle hover marker.
 * The outline comes from the same attachment surface the binding uses, so the hint and the binding cannot disagree. */
export function createConnectorHints(options: ConnectorHintOptions) {
    const { runtime } = options, doc = runtime.session.doc;
    let wanted: NodeId | null = null, surface: Surface | null = null, generation = 0, disposed = false;
    let bindings: readonly BindingSegment[] | null = null;
    // An elbow end being dragged (or hovered, without an anchor yet) adds the edge dots to the outline (catalogue a.9).
    let elbow: ElbowHint | null = null, hoverElbow = false;
    // The arrow tool's idle hover (catalogue a.2, a.9): a ring at the target's centre (imprecise), and after the hover hold on the
    // same target a cross at the pointer (precise). Alt is exact: the outline only. Drags clear it, so a drag's stubs are never hidden.
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
        // The edge handles are filled dots; the snap circles above are rings.
        dotPath.setAttribute('fill', HINT_STROKE); dotPath.setAttribute('stroke', 'none'); svg.append(dotPath);
        options.overlay.append(svg);
    };
    // The marks drawn over the stubs: the hover marker while the arrow tool hovers a target, else the bound stubs.
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
            // The outline and its snap circle share one path string, compared as a whole, so a circle that goes away is erased too.
            const full = ringed ? `${parts.join(' ')} ${ringed}` : parts.join(' ');
            if (full !== targetPainted) { targetPainted = full; targetPath!.setAttribute('d', full); }
            const dd = dots.handles.map(handle => disc(at(handle), HANDLE_RADIUS)).join(' ');
            if (dd !== dotPainted) { dotPainted = dd; dotPath!.setAttribute('d', dd); }
        } else if (targetPainted) { targetPainted = ''; targetPath!.setAttribute('d', ''); dotPainted = ''; dotPath!.setAttribute('d', ''); }
        if (shown?.length) {
            const at = (p: Vec2) => worldToSurface(p, camera);
            // Below zoom 0.2 the stub is solid: a dash period is under a pixel there (catalogue §7 a.9).
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
        // A connector or group has no outline to bind to, and the binding resolver refuses both.
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
        /** The bound ends' stubs, or null: the selected arrow's own binding, or the one an endpoint drag is making. */
        setBinding(segments: readonly BindingSegment[] | null): void { bindings = segments && segments.length ? segments : null; options.invalidate(); },
        /** The target to show, or null, for a drag: it clears the hover marker. Its outline is read from the target's geometry
         * asynchronously; the last request wins. */
        setTarget(target: NodeId | null, elbowHint: ElbowHint | null = null): void { clearHover(); elbow = elbowHint; showTarget(target); },
        /** The arrow tool's idle hover: the target under the pointer (null for none), the pointer's world point, and whether Alt makes
         * the binding exact. A new target starts its hover hold; the same target keeps it. */
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
