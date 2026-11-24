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
import { handleRadius, pointerIsCoarse } from './pointerKind';

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
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The four neighbour points in world coordinates, written into `out` (x, y pairs in `directions` order), shifted by a drag's
 * translation. By reading: the old per-direction lookup read the node's pose four times a frame and allocated a point each. */
function directionPoints(runtime: BoardRuntime, node: Readonly<StickyNode>, out: Float64Array, shiftX: number, shiftY: number): void {
    const pose = worldPose(runtime.session.doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    const width = 200 * node.scale, height = (200 + node.growY) * node.scale;
    for (let i = 0; i < directions.length; i++) {
        const direction = directions[i];
        const x = direction === 'left' ? 0 : direction === 'right' ? width : width / 2;
        const y = direction === 'up' ? 0 : direction === 'down' ? height : height / 2;
        out[2 * i] = pose.x + c * x - s * y + shiftX; out[2 * i + 1] = pose.y + s * x + c * y + shiftY;
    }
}
interface Button { readonly circle: SVGCircleElement; readonly across: SVGLineElement; readonly down: SVGLineElement; readonly at: Float64Array }

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
    const clear = () => { svg?.remove(); svg = undefined; buttons = null; presented.clear(); };
    // The four buttons are built once per svg and moved by their numbers: a frame that moves nothing writes nothing. By reading:
    // the frame replaced all twelve nodes every time, and during a drag the sticky moves on every move.
    let buttons: readonly Button[] | null = null;
    let coarseShown = pointerIsCoarse();
    const scratch = new Float64Array(directions.length * 2), hitScratch = new Float64Array(directions.length * 2);
    const paint = (node: Readonly<StickyNode>, camera: ViewState['camera'], moving: Vec2 | null) => {
        if (!svg) {
            svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg);
            buttons = null;
        }
        const parent = svg;
        // The neighbour dots grow for a finger or a pen (catalogue I§4.5); they keep their nodes and only change their radius.
        if (buttons && coarseShown !== pointerIsCoarse()) { coarseShown = pointerIsCoarse(); for (const button of buttons) button.circle.setAttribute('r', String(handleRadius(7))); }
        if (!buttons) buttons = directions.map(() => {
            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('r', String(handleRadius(7))); circle.setAttribute('fill', '#ffffff'); circle.setAttribute('stroke', '#75b7ff'); circle.setAttribute('stroke-width', '1.5');
            const across = document.createElementNS(SVG_NS, 'line'), down = document.createElementNS(SVG_NS, 'line');
            across.setAttribute('stroke', '#3476c7'); across.setAttribute('stroke-width', '1.5');
            down.setAttribute('stroke', '#3476c7'); down.setAttribute('stroke-width', '1.5');
            parent.append(circle, across, down);
            return { circle, across, down, at: new Float64Array([Number.NaN, Number.NaN]) };
        });
        directionPoints(runtime, node, scratch, moving ? moving.x : 0, moving ? moving.y : 0);
        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            // The same mapping as worldToSurface, inline so a frame allocates no point.
            const x = (scratch[2 * i] - camera.x) * camera.z, y = (scratch[2 * i + 1] - camera.y) * camera.z;
            if (button.at[0] === x && button.at[1] === y) continue;
            button.at[0] = x; button.at[1] = y;
            button.circle.setAttribute('cx', String(x)); button.circle.setAttribute('cy', String(y));
            button.across.setAttribute('x1', String(x - 3)); button.across.setAttribute('y1', String(y));
            button.across.setAttribute('x2', String(x + 3)); button.across.setAttribute('y2', String(y));
            button.down.setAttribute('x1', String(x)); button.down.setAttribute('y1', String(y - 3));
            button.down.setAttribute('x2', String(x)); button.down.setAttribute('y2', String(y + 3));
        }
    };

    const invalidate = () => { if (current()) options.invalidate(); else clear(); };
    const stopSelection = runtime.selection.subscribe(invalidate), stopSession = session.subscribe(invalidate);
    return {
        hit(surface: Vec2, coarse = false, time?: number): StickyDirection | null {
            const node = selected(), camera = presented.at(time);
            if (!node || !camera || ![surface.x, surface.y].every(Number.isFinite)) return null;
            directionPoints(runtime, node, hitScratch, 0, 0);
            // Default, calibration cut by owner: the touch target is larger than the visible button.
            const radius = coarse ? 18 : 9;
            for (let i = 0; i < directions.length; i++) {
                const x = (hitScratch[2 * i] - camera.x) * camera.z, y = (hitScratch[2 * i + 1] - camera.y) * camera.z;
                if (Math.hypot(surface.x - x, surface.y - y) <= radius) return directions[i];
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
        write(frame: ScheduledFrame, moving: Vec2 | null = null) {
            const node = selected(); if (!node) { clear(); return; }
            presented.present(frame.timestamp, { ...frame.view.camera });
            paint(node, frame.view.camera, moving);
        },
        writeLive(view: ViewState, moving: Vec2 | null = null) {
            const node = selected(); if (node) paint(node, view.camera, moving);
        },
        hide() { pending?.abort(); pending = undefined; clear(); if (current()) options.invalidate(); },
        dispose() { if (disposed) return; disposed = true; pending?.abort(); pending = undefined; stopSelection(); stopSession(); clear(); },
    };
}
