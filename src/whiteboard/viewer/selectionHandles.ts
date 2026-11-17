import { worldToSurface } from '../../platform/render/camera';
import { auditCount, auditTimed } from '../../platform/render/renderAudit';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ViewState } from '../../platform/types';
import { isLocked, selectedRoots } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { inverse } from '../geom/affine';
import type { Vec2 } from '../geom/path';
import { commonResizeRotation, type OrientedBox, type ResizeHandle } from '../geom/transforms';
import type { BoardRuntime } from '../host/runtime';
import { PresentedHistory } from '../input/presentedHistory';
import { childrenOf, hasOpaqueDescendant } from '../model/doc';
import type { NodeId } from '../model/ids';

export type SelectionHandleHit = Readonly<{ kind: 'resize'; handle: ResizeHandle }> | Readonly<{ kind: 'rotate'; centre: Vec2; orientation: number }>;
export interface SelectionHandleOptions {
    readonly runtime: BoardRuntime;
    readonly overlay: HTMLElement;
    readonly camera: () => ViewState;
    readonly current: () => boolean;
    readonly visible: () => boolean;
    readonly invalidate: () => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}
const handles: readonly ResizeHandle[] = [{ x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 },
    { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }];
function point(box: OrientedBox, x: number, y: number): Vec2 {
    const c = Math.cos(box.rotation), s = Math.sin(box.rotation);
    return { x: box.origin.x + c * x - s * y, y: box.origin.y + s * x + c * y };
}
function projected(box: OrientedBox, view: ViewState) {
    const positions = handles.map(handle => worldToSurface(point(box, (handle.x + 1) * box.width / 2, (handle.y + 1) * box.height / 2), view.camera));
    const corner = positions[2], centre = worldToSurface(point(box, box.width / 2, box.height / 2), view.camera);
    const dx = corner.x - centre.x, dy = corner.y - centre.y, length = Math.hypot(dx, dy) || 1;
    return { positions, rotate: { x: corner.x + dx / length * 11.25, y: corner.y + dy / length * 11.25 } };
}

/** Mounted chrome only: the session and renderer keep all document geometry. */
const SVG_NS = 'http://www.w3.org/2000/svg';
interface HandleNodes { readonly path: SVGPolygonElement; readonly stem: SVGLineElement; readonly rotate: SVGCircleElement; readonly circles: SVGCircleElement[] }
/** Builds one frame's handle elements once, in paint order: outline, stem, rotation grip, then the resize handles. */
function buildHandleNodes(parent: SVGSVGElement, handleCount: number): HandleNodes {
    const path = document.createElementNS(SVG_NS, 'polygon'), stem = document.createElementNS(SVG_NS, 'line'), rotate = document.createElementNS(SVG_NS, 'circle');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#75b7ff'); path.setAttribute('stroke-width', '1.5');
    stem.setAttribute('stroke', '#75b7ff'); stem.setAttribute('stroke-width', '1.5');
    rotate.setAttribute('r', '3'); rotate.setAttribute('fill', '#ffffff'); rotate.setAttribute('stroke', '#75b7ff'); rotate.setAttribute('stroke-width', '1.5');
    parent.append(path, stem, rotate);
    const circles = Array.from({ length: handleCount }, () => {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('r', '4'); circle.setAttribute('fill', '#ffffff'); circle.setAttribute('stroke', '#75b7ff'); circle.setAttribute('stroke-width', '1.5');
        parent.append(circle); return circle;
    });
    auditCount('select-handles', 'node-build', 1, { nodes: 3 + handleCount });
    return { path, stem, rotate, circles };
}
/** Sets an attribute only when its value changed, so an unmoved handle costs no style or layout work. */
function put(element: Element, name: string, value: string): void {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function createSelectionHandles(options: SelectionHandleOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    let box: OrientedBox | null = null, controller: AbortController | undefined, generation = 0, disposed = false;
    let svg: SVGSVGElement | undefined;
    let handleNodes: HandleNodes | undefined;
    const presented = new PresentedHistory<ViewState['camera']>();
    const current = () => !disposed && options.current() && options.visible() && session.doc === doc;
    const clear = () => { box = null; svg?.remove(); svg = undefined; presented.clear(); options.invalidate(); };
    const refresh = () => {
        const turn = ++generation; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
        clear(); if (!current()) return;
        const selection = runtime.selection.getSnapshot(), revision = doc.rev, owner = session.owner;
        const roots = selectedRoots(doc, selection.selected).filter(node => node.kind !== 'opaque' && !isLocked(doc, node) && !hasOpaqueDescendant(doc, node.id));
        // An individual sticky uses neighbour controls, not resize handles.
        if (!roots.length || (roots.length === 1 && roots[0].kind === 'sticky')) return;
        const active = () => !signal.aborted && turn === generation && current() && session.owner === owner && doc.rev === revision
            && runtime.selection.getSnapshot() === selection;
        void (async () => {
            const scope = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { signal, current: active, cooperate: options.cooperate });
            try {
                if (!active()) return;
                const rotations: number[] = [], pending = [...roots], cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
                let visited = 0;
                while (pending.length) {
                    if (!active()) return;
                    const node = pending.pop()!;
                    if (++visited % 256 === 0) { await cooperate(); if (!active()) return; }
                    if (node.locked) continue;
                    if (node.kind === 'group') { for (const child of childrenOf(doc, node.id)) pending.push(child); }
                    else rotations.push(worldPose(doc, node.id).rotation);
                }
                if (!rotations.length) return;
                const rotation = commonResizeRotation(rotations) ?? 0, c = Math.cos(rotation), s = Math.sin(rotation);
                const target = inverse([c, s, -s, c, 0, 0], 1e12); if (!target) throw new Error('Selection frame is not invertible');
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (const root of roots) {
                    const b = await scope.boundsInSpace(root.id, target); if (!active()) return;
                    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
                }
                if (!(x1 > x0) || !(y1 > y0)) return;
                box = { origin: { x: c * x0 - s * y0, y: s * x0 + c * y0 }, width: x1 - x0, height: y1 - y0, rotation };
                options.invalidate();
            } finally { scope.release(); }
        })().catch(error => { if (active()) options.error(error); });
    };
    const stopSelection = runtime.selection.subscribe(refresh), stopSession = session.subscribe(refresh);
    refresh();
    // The nodes live as long as their svg: a frame moves their coordinates, it does not build new elements.
    const draw = (shape: OrientedBox, view: ViewState, moving: Vec2 | 'hidden' | null) => {
        if (moving === 'hidden') { if (svg) svg.style.display = 'none'; return; }
        if (svg) svg.style.display = '';
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg);
            handleNodes = undefined;
        }
        const shown: OrientedBox = moving ? { ...shape, origin: { x: shape.origin.x + moving.x, y: shape.origin.y + moving.y } } : shape;
        const geometry = projected(shown, view);
        const nodes = handleNodes ??= buildHandleNodes(svg, geometry.positions.length);
        put(nodes.path, 'points', [0, 2, 4, 6].map(i => `${geometry.positions[i].x},${geometry.positions[i].y}`).join(' '));
        put(nodes.stem, 'x1', String(geometry.positions[2].x)); put(nodes.stem, 'y1', String(geometry.positions[2].y));
        put(nodes.stem, 'x2', String(geometry.rotate.x)); put(nodes.stem, 'y2', String(geometry.rotate.y));
        put(nodes.rotate, 'cx', String(geometry.rotate.x)); put(nodes.rotate, 'cy', String(geometry.rotate.y));
        geometry.positions.forEach((position, i) => { put(nodes.circles[i], 'cx', String(position.x)); put(nodes.circles[i], 'cy', String(position.y)); });
    };
    return {
        refresh,
        contains(world: Vec2, time?: number): boolean {
            const camera = presented.at(time);
            if (!current() || !box || !camera || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return false;
            const dx = world.x - box.origin.x, dy = world.y - box.origin.y, c = Math.cos(box.rotation), s = Math.sin(box.rotation);
            const x = c * dx + s * dy, y = -s * dx + c * dy, margin = 8 / camera.z;
            return Number.isFinite(margin) && x >= -margin && x <= box.width + margin && y >= -margin && y <= box.height + margin;
        },
        hit(surface: Vec2, coarse = false, time?: number): SelectionHandleHit | null {
            const camera = presented.at(time);
            if (!current() || !box || !camera || !Number.isFinite(surface.x) || !Number.isFinite(surface.y)) return null;
            // Default, calibration cut by owner: resize precedes the outward rotation hotspot.
            const geometry = projected(box, { ...options.camera(), camera }), radius = coarse ? 14 : 6;
            for (let i = 0; i < handles.length; i++) if (Math.hypot(surface.x - geometry.positions[i].x, surface.y - geometry.positions[i].y) <= radius)
                return { kind: 'resize', handle: handles[i] };
            if (Math.hypot(surface.x - geometry.rotate.x, surface.y - geometry.rotate.y) <= (coarse ? 10 : 3.5))
                return { kind: 'rotate', centre: point(box, box.width / 2, box.height / 2), orientation: box.rotation };
            return null;
        },
        /** `moving`: a translation preview moves the box by its offset, so it follows the drag; `'hidden'` (a transform that
         * is not a plain translation) hides the box while the preview shows the shape elsewhere. */
        // Audit only: the time each frame's handle write takes, and the DOM nodes it builds.
        write: (frame: ScheduledFrame, moving: Vec2 | 'hidden' | null = null) => auditTimed('select-handles', () => {
            auditCount('select-handles', 'frame');
            if (!current() || !box) { svg?.remove(); svg = undefined; presented.clear(); return; }
            presented.present(frame.timestamp, { ...frame.view.camera });
            draw(box, frame.view, moving);
        }),
        /** A move that no presented frame followed (the board stalled under the large seed): the same nodes, written with the
         * live view. It does not present history, so a hit test still uses the camera the board actually showed. */
        writeLive: (view: ViewState, moving: Vec2 | 'hidden' | null = null) => auditTimed('select-handles', () => {
            auditCount('select-handles', 'live');
            if (!current() || !box) return;
            draw(box, view, moving);
        }),
        hide() { generation++; controller?.abort(); clear(); },
        dispose() { if (disposed) return; disposed = true; generation++; controller?.abort(); stopSelection(); stopSession(); svg?.remove(); svg = undefined; box = null; presented.clear(); },
    };
}
