import { worldPose } from '../change/coordinates';
import { worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { Affine, ViewState } from '../../platform/types';
import { transformPoint } from '../geom/affine';
import type { ConnectorGeometry } from '../geom/connectorTypes';
import type { PathOp, Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { ConnectorNode } from '../model/nodes';

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
type Surface = { readonly outline: readonly PathOp[]; readonly localToWorld: Affine };

/** The arrow hints drawn over the board: the outline of the shape an arrow end would bind to (catalogue §7 a.9, the target
 * hint), and the stubs of the bound ends of the selected arrow. The outline comes from the same attachment surface the
 * binding uses, so the hint and the binding cannot disagree. */
export function createConnectorHints(options: ConnectorHintOptions) {
    const { runtime } = options, doc = runtime.session.doc;
    let wanted: NodeId | null = null, surface: Surface | null = null, generation = 0, disposed = false;
    let bindings: readonly BindingSegment[] | null = null;
    let controller: AbortController | undefined, svg: SVGSVGElement | undefined, targetPath: SVGPathElement | undefined, bindingPath: SVGPathElement | undefined;
    let targetPainted = '', bindingPainted = '', bindingDash = '';
    const current = () => !disposed && options.current() && runtime.session.doc === doc;
    const ensure = () => {
        if (svg) return;
        svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
        svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible';
        targetPath = document.createElementNS(SVG_NS, 'path'); bindingPath = document.createElementNS(SVG_NS, 'path');
        for (const path of [targetPath, bindingPath]) { path.setAttribute('fill', 'none'); path.setAttribute('stroke', HINT_STROKE); path.setAttribute('stroke-width', '1.5'); svg.append(path); }
        options.overlay.append(svg);
    };
    const paint = (camera: ViewState['camera']) => {
        if (!surface && !bindings?.length) { if (svg) { targetPath?.setAttribute('d', ''); bindingPath?.setAttribute('d', ''); targetPainted = bindingPainted = ''; } return; }
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
            const d = parts.join(' ');
            if (d !== targetPainted) { targetPainted = d; targetPath!.setAttribute('d', d); }
        } else if (targetPainted) { targetPainted = ''; targetPath!.setAttribute('d', ''); }
        if (bindings?.length) {
            const at = (p: Vec2) => worldToSurface(p, camera);
            // Below zoom 0.2 the stub is solid: a dash period is under a pixel there (catalogue §7 a.9).
            const dash = camera.z >= 0.2 ? '4 4' : '';
            const parts: string[] = [];
            for (const { from, to, mark } of bindings) {
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
    return {
        /** The bound ends' stubs, or null: the selected arrow's own binding, or the one an endpoint drag is making. */
        setBinding(segments: readonly BindingSegment[] | null): void { bindings = segments && segments.length ? segments : null; options.invalidate(); },
        /** The target to show, or null. Its outline is read from the target's geometry asynchronously; the last request wins. */
        setTarget(target: NodeId | null): void {
            if (target === wanted) return;
            wanted = target; generation++; controller?.abort(); controller = undefined;
            const node = target === null ? undefined : doc.nodes.get(target);
            // A connector or group has no outline to bind to, and the binding resolver refuses both.
            if (!node || node.kind === 'connector' || node.kind === 'group' || node.kind === 'opaque') { surface = null; options.invalidate(); return; }
            const turn = generation, request = new AbortController(); controller = request;
            void runtime.render.prepareForPick(node, request.signal, doc).then(prepared => {
                if (request.signal.aborted || turn !== generation || !current()) return;
                const attachments = prepared.vector?.attachments, pose = worldPose(doc, node.id);
                const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                surface = attachments ? { outline: attachments.outline, localToWorld: [c, s, -s, c, pose.x, pose.y] } : null;
                options.invalidate();
            }).catch(() => { if (turn === generation) { surface = null; options.invalidate(); } });
        },
        write(frame: ScheduledFrame) { if (current()) paint(frame.view.camera); },
        writeLive(view: ViewState) { if (current()) paint(view.camera); },
        dispose(): void {
            if (disposed) return; disposed = true; generation++; controller?.abort();
            svg?.remove(); svg = undefined; targetPath = undefined; bindingPath = undefined; surface = null; wanted = null; bindings = null;
        },
    };
}
