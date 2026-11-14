import { worldToSurface } from '../../platform/render/camera';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ViewState } from '../../platform/types';
import { isLocked } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { addStickyNeighbour, type StickyDirection } from '../commands/stickyNeighbour';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import { PresentedHistory } from '../input/presentedHistory';
import type { NodeId } from '../model/ids';
import type { StickyNode } from '../model/nodes';

export interface StickyHandleOptions {
    readonly runtime: BoardRuntime;
    readonly overlay: HTMLElement;
    readonly view: () => ViewState;
    readonly current: () => boolean;
    readonly visible: () => boolean;
    readonly invalidate: () => void;
    readonly edit: (id: NodeId) => void | Promise<void>;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}
const directions: readonly StickyDirection[] = ['up', 'right', 'down', 'left'];
function worldPoint(runtime: BoardRuntime, node: Readonly<StickyNode>, direction: StickyDirection): Vec2 {
    const pose = worldPose(runtime.session.doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    const width = 200 * node.scale, height = (200 + node.growY) * node.scale;
    const x = direction === 'left' ? 0 : direction === 'right' ? width : width / 2;
    const y = direction === 'up' ? 0 : direction === 'down' ? height : height / 2;
    return { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y };
}

/** Sticky neighbour chrome is a view of the selected session node, not saved content. */
export function createStickyHandles(options: StickyHandleOptions) {
    const { runtime } = options, session = runtime.session;
    let svg: SVGSVGElement | undefined, pending: AbortController | undefined, disposed = false;
    const presented = new PresentedHistory<ViewState['camera']>();
    const current = () => !disposed && options.current() && options.visible();
    const selected = (): Readonly<StickyNode> | null => {
        if (!current()) return null;
        const state = runtime.selection.getSnapshot(); if (state.selected.length !== 1) return null;
        const node = session.doc.nodes.get(state.selected[0]);
        return node?.kind === 'sticky' && !isLocked(session.doc, node) ? node : null;
    };
    const clear = () => { svg?.remove(); svg = undefined; presented.clear(); };
    const invalidate = () => { if (current()) options.invalidate(); else clear(); };
    const stopSelection = runtime.selection.subscribe(invalidate), stopSession = session.subscribe(invalidate);
    return {
        hit(surface: Vec2, coarse = false, time?: number): StickyDirection | null {
            const node = selected(), camera = presented.at(time);
            if (!node || !camera || ![surface.x, surface.y].every(Number.isFinite)) return null;
            // Default, calibration cut by owner: the touch target is larger than the visible button.
            const radius = coarse ? 18 : 9;
            for (const direction of directions) {
                const p = worldToSurface(worldPoint(runtime, node, direction), camera);
                if (Math.hypot(surface.x - p.x, surface.y - p.y) <= radius) return direction;
            }
            return null;
        },
        async activate(direction: StickyDirection, reuse: boolean): Promise<NodeId | null> {
            const node = selected(); if (!node || pending) return null;
            pending = new AbortController(); const request = pending, view = options.view();
            try {
                return await addStickyNeighbour({ runtime, id: node.id, direction, reuse, zoom: presented.at()?.z ?? view.camera.z,
                    signal: request.signal, current, edit: options.edit, cooperate: options.cooperate });
            } catch (error) { if (!request.signal.aborted && current()) options.error(error); return null; }
            finally { if (pending === request) pending = undefined; }
        },
        write(frame: ScheduledFrame) {
            const node = selected(); if (!node) { clear(); return; }
            presented.present(frame.timestamp, { ...frame.view.camera });
            if (!svg) {
                svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
                svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg);
            }
            svg.replaceChildren();
            for (const direction of directions) {
                const p = worldToSurface(worldPoint(runtime, node, direction), frame.view.camera);
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', String(p.x)); circle.setAttribute('cy', String(p.y)); circle.setAttribute('r', '7');
                circle.setAttribute('fill', '#ffffff'); circle.setAttribute('stroke', '#75b7ff'); circle.setAttribute('stroke-width', '1.5'); svg.append(circle);
                for (const [x1, y1, x2, y2] of [[p.x - 3, p.y, p.x + 3, p.y], [p.x, p.y - 3, p.x, p.y + 3]]) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1)); line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
                    line.setAttribute('stroke', '#3476c7'); line.setAttribute('stroke-width', '1.5'); svg.append(line);
                }
            }
        },
        hide() { pending?.abort(); pending = undefined; clear(); if (current()) options.invalidate(); },
        dispose() { if (disposed) return; disposed = true; pending?.abort(); pending = undefined; stopSelection(); stopSession(); clear(); },
    };
}
