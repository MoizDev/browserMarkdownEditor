import { worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ViewState } from '../../platform/types';
import { isLocked, selectedRoots } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { inverse } from '../geom/affine';
import type { Vec2 } from '../geom/path';
import { commonResizeRotation, type OrientedBox, type ResizeHandle } from '../geom/transforms';
import type { BoardRuntime } from '../host/runtime';
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
export function createSelectionHandles(options: SelectionHandleOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    let box: OrientedBox | null = null, controller: AbortController | undefined, generation = 0, disposed = false;
    let svg: SVGSVGElement | undefined, hitCamera: ViewState['camera'] | null = null;
    const current = () => !disposed && options.current() && options.visible() && session.doc === doc;
    const clear = () => { box = null; svg?.remove(); svg = undefined; hitCamera = null; options.invalidate(); };
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
                const pending = [...roots]; let visited = 0, reference: number | undefined, mixed = false;
                while (pending.length) {
                    if (!active()) return;
                    const node = pending.pop()!;
                    if (node.kind === 'group') { for (const child of childrenOf(doc, node.id)) pending.push(child); }
                    else {
                        const angle = worldPose(doc, node.id).rotation;
                        if (reference === undefined) reference = angle;
                        else if (commonResizeRotation([reference, angle]) === null) mixed = true;
                    }
                    if (++visited % 128 === 0) {
                        await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
                        if (!active()) return;
                    }
                }
                const rotation = mixed ? 0 : reference ?? 0, c = Math.cos(rotation), s = Math.sin(rotation);
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
    return {
        refresh,
        contains(world: Vec2): boolean {
            if (!current() || !box || !hitCamera || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return false;
            const dx = world.x - box.origin.x, dy = world.y - box.origin.y, c = Math.cos(box.rotation), s = Math.sin(box.rotation);
            const x = c * dx + s * dy, y = -s * dx + c * dy, margin = 8 / hitCamera.z;
            return Number.isFinite(margin) && x >= -margin && x <= box.width + margin && y >= -margin && y <= box.height + margin;
        },
        hit(surface: Vec2, coarse = false): SelectionHandleHit | null {
            if (!current() || !box || !hitCamera || !Number.isFinite(surface.x) || !Number.isFinite(surface.y)) return null;
            // Default, calibration cut by owner: resize precedes the outward rotation hotspot.
            const geometry = projected(box, { ...options.camera(), camera: hitCamera }), radius = coarse ? 14 : 6;
            for (let i = 0; i < handles.length; i++) if (Math.hypot(surface.x - geometry.positions[i].x, surface.y - geometry.positions[i].y) <= radius)
                return { kind: 'resize', handle: handles[i] };
            if (Math.hypot(surface.x - geometry.rotate.x, surface.y - geometry.rotate.y) <= (coarse ? 10 : 3.5))
                return { kind: 'rotate', centre: point(box, box.width / 2, box.height / 2), orientation: box.rotation };
            return null;
        },
        write(frame: ScheduledFrame) {
            if (!current() || !box) { svg?.remove(); svg = undefined; hitCamera = null; return; }
            hitCamera = { ...frame.view.camera };
            if (!svg) {
                svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
                svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg);
            }
            const geometry = projected(box, frame.view), path = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            path.setAttribute('points', [0, 2, 4, 6].map(i => `${geometry.positions[i].x},${geometry.positions[i].y}`).join(' '));
            path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#75b7ff'); path.setAttribute('stroke-width', '1.5');
            svg.replaceChildren(path);
            const rotation = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            rotation.setAttribute('cx', String(geometry.rotate.x)); rotation.setAttribute('cy', String(geometry.rotate.y));
            rotation.setAttribute('r', '3'); rotation.setAttribute('fill', '#ffffff');
            rotation.setAttribute('stroke', '#75b7ff'); rotation.setAttribute('stroke-width', '1.5'); svg.append(rotation);
            for (const position of geometry.positions) {
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', String(position.x)); circle.setAttribute('cy', String(position.y)); circle.setAttribute('r', '4');
                circle.setAttribute('fill', '#ffffff'); circle.setAttribute('stroke', '#75b7ff'); circle.setAttribute('stroke-width', '1.5'); svg.append(circle);
            }
        },
        hide() { generation++; controller?.abort(); clear(); },
        dispose() { if (disposed) return; disposed = true; generation++; controller?.abort(); stopSelection(); stopSession(); svg?.remove(); svg = undefined; box = null; hitCamera = null; },
    };
}
