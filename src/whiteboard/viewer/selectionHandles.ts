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
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import { handleRadius, pointerIsCoarse } from './pointerKind';

export type SelectionHandleHit = Readonly<{ kind: 'resize'; handle: ResizeHandle }> | Readonly<{ kind: 'rotate'; centre: Vec2; orientation: number }>;
export interface SelectionHandleOptions {
    readonly runtime: BoardRuntime;
    readonly overlay: HTMLElement;
    /** Absent for an outline, which has no handles to hit. */
    readonly camera?: () => ViewState;
    /** A read-only view draws the selection frame's outline alone: its box and stroke, and no handles, grip or stem, since
     * nothing can be dragged there. */
    readonly outlineOnly?: boolean;
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
/** Surface positions of the box's handles, written into `out` (no per-frame arrays): the eight resize handles as x, y pairs,
 * then the rotation grip at index 16 (x) and 17 (y). Measured by reading only: the frame path made a fresh array of eight
 * points and a rotation point for every frame, and the outline made a string from them. */
const PROJECTED = 18;
function projectInto(box: OrientedBox, view: ViewState, out: Float64Array, shiftX = 0, shiftY = 0): void {
    for (let i = 0; i < handles.length; i++) {
        const world = point(box, (handles[i].x + 1) * box.width / 2, (handles[i].y + 1) * box.height / 2);
        const position = worldToSurface({ x: world.x + shiftX, y: world.y + shiftY }, view.camera);
        out[2 * i] = position.x; out[2 * i + 1] = position.y;
    }
    const centreWorld = point(box, box.width / 2, box.height / 2);
    const centre = worldToSurface({ x: centreWorld.x + shiftX, y: centreWorld.y + shiftY }, view.camera);
    const cornerX = out[4], cornerY = out[5];
    const dx = cornerX - centre.x, dy = cornerY - centre.y, length = Math.hypot(dx, dy) || 1;
    out[16] = cornerX + dx / length * 11.25; out[17] = cornerY + dy / length * 11.25;
}

/** Mounted chrome only: the session and renderer keep all document geometry. */
const SVG_NS = 'http://www.w3.org/2000/svg';
/** `last` holds the value each attribute was last written with: circles x, y pairs at 0–15, the grip at 16–17, the stem's
 * x1, y1, x2, y2 at 18–21. A frame compares numbers here and touches the DOM only for what moved, so an unmoved handle
 * costs no attribute read and no write. */
interface HandleNodes { coarse: boolean; readonly path: SVGPolygonElement; readonly stem: SVGLineElement; readonly rotate: SVGCircleElement; readonly circles: SVGCircleElement[]; readonly last: Float64Array }
/** Builds one frame's handle elements once, in paint order: outline, stem, rotation grip, then the resize handles. */
function buildHandleNodes(parent: SVGSVGElement, handleCount: number): HandleNodes {
    const path = document.createElementNS(SVG_NS, 'polygon'), stem = document.createElementNS(SVG_NS, 'line'), rotate = document.createElementNS(SVG_NS, 'circle');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#75b7ff'); path.setAttribute('stroke-width', '1.5');
    stem.setAttribute('stroke', '#75b7ff'); stem.setAttribute('stroke-width', '1.5');
    rotate.setAttribute('r', String(handleRadius(3))); rotate.setAttribute('fill', '#ffffff'); rotate.setAttribute('stroke', '#75b7ff'); rotate.setAttribute('stroke-width', '1.5');
    parent.append(path, stem, rotate);
    const circles = Array.from({ length: handleCount }, () => {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('r', String(handleRadius(4))); circle.setAttribute('fill', '#ffffff'); circle.setAttribute('stroke', '#75b7ff'); circle.setAttribute('stroke-width', '1.5');
        parent.append(circle); return circle;
    });
    auditCount('select-handles', 'node-build', 1, { nodes: 3 + handleCount });
    return { coarse: pointerIsCoarse(), path, stem, rotate, circles, last: new Float64Array(PROJECTED + 4).fill(Number.NaN) };
}

/** The world rotations of the unlocked leaves under `roots` (a group's children, recursively). The selection frame and the hover
 * outline both draw their box in `commonResizeRotation` of these, so a group is boxed the same way selected and hovered. */
export function frameLeafRotations(doc: BoardDoc, roots: readonly Node[]): number[] {
    const rotations: number[] = [], pending = [...roots];
    while (pending.length) {
        const node = pending.pop()!;
        if (node.locked) continue;
        if (node.kind === 'group') { for (const child of childrenOf(doc, node.id)) pending.push(child); }
        else rotations.push(worldPose(doc, node.id).rotation);
    }
    return rotations;
}

export function createSelectionHandles(options: SelectionHandleOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    let box: OrientedBox | null = null, controller: AbortController | undefined, generation = 0, disposed = false;
    let svg: SVGSVGElement | undefined;
    let handleNodes: HandleNodes | undefined, outlineNode: SVGPolygonElement | undefined;
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
                const rotations = frameLeafRotations(doc, roots);
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
    // A frame's positions go to one scratch array, and each attribute is written only when its number changed: a frame that
    // moves nothing touches no DOM node (by reading: the old frame re-set every attribute and the outline string each time).
    const drawn = new Float64Array(PROJECTED);
    const hitPositions = new Float64Array(PROJECTED);
    const draw = (shape: OrientedBox, view: ViewState, moving: Vec2 | 'hidden' | null) => {
        if (moving === 'hidden') { if (svg && svg.style.display !== 'none') svg.style.display = 'none'; return; }
        if (svg && svg.style.display !== '') svg.style.display = '';
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
            svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; options.overlay.append(svg);
            handleNodes = undefined; outlineNode = undefined;
        }
        projectInto(shape, view, drawn, moving ? moving.x : 0, moving ? moving.y : 0);
        if (options.outlineOnly) {
            outlineNode ??= document.createElementNS(SVG_NS, 'polygon');
            if (!outlineNode.parentNode) {
                outlineNode.setAttribute('fill', 'none'); outlineNode.setAttribute('stroke', '#75b7ff'); outlineNode.setAttribute('stroke-width', '1.5');
                svg.append(outlineNode);
            }
            outlineNode.setAttribute('points', `${drawn[0]},${drawn[1]} ${drawn[4]},${drawn[5]} ${drawn[8]},${drawn[9]} ${drawn[12]},${drawn[13]}`);
            return;
        }
        const nodes = handleNodes ??= buildHandleNodes(svg, handles.length);
        const last = nodes.last;
        // The handles grow for a finger or a pen, the size the catalogue uses for a coarse pointer (I§4.5).
        if (nodes.coarse !== pointerIsCoarse()) {
            nodes.coarse = !nodes.coarse;
            nodes.rotate.setAttribute('r', String(handleRadius(3)));
            for (const circle of nodes.circles) circle.setAttribute('r', String(handleRadius(4)));
        }
        let outline = false;
        for (let i = 0; i < handles.length; i++) {
            const x = drawn[2 * i], y = drawn[2 * i + 1];
            if (last[2 * i] !== x) { last[2 * i] = x; nodes.circles[i].setAttribute('cx', String(x)); if (!(i & 1)) outline = true; }
            if (last[2 * i + 1] !== y) { last[2 * i + 1] = y; nodes.circles[i].setAttribute('cy', String(y)); if (!(i & 1)) outline = true; }
        }
        // The outline is the four corners (handles 0, 2, 4, 6), so its string is rebuilt only when one of them moved.
        if (outline) nodes.path.setAttribute('points', `${drawn[0]},${drawn[1]} ${drawn[4]},${drawn[5]} ${drawn[8]},${drawn[9]} ${drawn[12]},${drawn[13]}`);
        const gripX = drawn[16], gripY = drawn[17];
        if (last[16] !== gripX) { last[16] = gripX; nodes.rotate.setAttribute('cx', String(gripX)); }
        if (last[17] !== gripY) { last[17] = gripY; nodes.rotate.setAttribute('cy', String(gripY)); }
        // The stem runs from the top-right corner (handle 2) to the grip.
        const x1 = drawn[4], y1 = drawn[5];
        if (last[18] !== x1) { last[18] = x1; nodes.stem.setAttribute('x1', String(x1)); }
        if (last[19] !== y1) { last[19] = y1; nodes.stem.setAttribute('y1', String(y1)); }
        if (last[20] !== gripX) { last[20] = gripX; nodes.stem.setAttribute('x2', String(gripX)); }
        if (last[21] !== gripY) { last[21] = gripY; nodes.stem.setAttribute('y2', String(gripY)); }
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
            if (!current() || !box || !camera || !options.camera || !Number.isFinite(surface.x) || !Number.isFinite(surface.y)) return null;
            // Default, calibration cut by owner: resize precedes the outward rotation hotspot.
            projectInto(box, { ...options.camera(), camera }, hitPositions);
            const radius = coarse ? 14 : 6;
            for (let i = 0; i < handles.length; i++) if (Math.hypot(surface.x - hitPositions[2 * i], surface.y - hitPositions[2 * i + 1]) <= radius)
                return { kind: 'resize', handle: handles[i] };
            if (Math.hypot(surface.x - hitPositions[16], surface.y - hitPositions[17]) <= (coarse ? 10 : 3.5))
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
