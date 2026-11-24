import type { Rect } from '../../platform/types';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Vec2 } from './path';
import { collectSnapCandidates, createSnapVisibility } from './snapCandidates';
import { prepareVisibleSnapBounds } from './snapVisibleBounds';
import { compareSnapMagnitude, exactDuplicateDisplacement, exactGapDisplacement, exactGapSize, exactSnapDisplacement, snapWithin, type ExactSnapDelta } from './snapArithmetic';
import type { Dyadic } from './numeric';
import { boardSnapGrid, nearestBoardGridCoordinate } from './gridSnap';
import { worldPose } from '../change/coordinates';
import { contourPolylines, nearestOnPolylines, rectOutline, transformPolylines, type OutlinePolyline } from './outlineSnap';
import { figureOutline } from './figures';
import { yieldToHost } from '../../platform/yieldToHost';

export interface BoardSnapGuide {
    readonly axis: 'x' | 'y';
    readonly value: number;
    readonly from: number;
    readonly to: number;
    readonly target?: NodeId;
    readonly kind?: 'alignment' | 'equal-gap' | 'grid';
    readonly featureAxis?: 'x' | 'y';
    /** Points on an alignment line where a feature of the moved box or of its target lands exactly; drawn as crosses. */
    readonly marks?: readonly Vec2[];
}
export interface BoardSnapResult {
    readonly delta: Vec2;
    readonly guides: readonly BoardSnapGuide[];
    /** The exact coordinate each point or outline snap landed on, per axis. `position + delta` can miss it by an ulp, so a
     * consumer that places a handle on the target reads this instead (measured: 290 + delta gave 290.00000000000006). */
    readonly landed?: { readonly x?: number; readonly y?: number };
}
export interface BoardSnapOptions {
    readonly runtime: BoardRuntime;
    /** Actual proposed logical bounds before applying the snap. */
    readonly bounds: Rect;
    readonly selected: readonly NodeId[];
    readonly zoom: number;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    readonly thresholdCss?: number;
    readonly allowX?: boolean;
    readonly allowY?: boolean;
    /** Alignment and gap snapping to other shapes. Callers decide it: Always snap XOR accel, the velocity gate, right-angle rotation. */
    readonly objects?: boolean;
    /** Show-grid lattice snapping. Callers pass false while the accelerator is held. Any object snap on either axis wins over the grid. */
    readonly grid?: boolean;
    /** Gap snapping (centre of a gap, duplicate gaps). A point has no width, so a point snap turns it off. */
    readonly gaps?: boolean;
    /** Point snapping for a handle or a new end: the nearest corner or centre of another box, or one of `ownPoints`, within the
     * threshold in both axes at once. Alignment to edges is not used; `outline` adds the edge fallback. */
    readonly points?: boolean;
    /** World positions the handle may snap to besides other boxes (the edited polyline's other vertices). */
    readonly ownPoints?: readonly Vec2[];
    /** With `points`: when no point is within the threshold, the nearest point on another figure's or line's outline (catalogue b.4). */
    readonly outline?: boolean;
}
type Axis = 'x' | 'y';
/** A snappable shape as the snap sees it: its visible logical box, and its rank for ties. */
interface Box { readonly id: NodeId; readonly rect: Readonly<Rect>; readonly rank: number }
/** A gap is a fact about the moved box's final position. Its anchors must still overlap the box across the other axis. */
interface GapFact {
    readonly kind: 'centre' | 'duplicate-before' | 'duplicate-after';
    /** centre: [left, right]. duplicate: [neighbour, referenceStart, referenceEnd]. */
    readonly anchors: readonly NodeId[];
}
interface Winner {
    readonly delta: ExactSnapDelta; readonly rank: number; readonly priority: number; readonly source: number; readonly edge: number;
    readonly gap?: GapFact; readonly grid?: { readonly value: number; readonly representable: boolean };
    /** The exact coordinate this winner lands on, when it lands on a point or an outline. */
    readonly target?: number;
}
/** Object snapping is skipped while the pointer moves at or above this speed (CSS px per ms), so a quick flick is not pulled
 * onto a guide. Measured against the catalogue's gate (0.5); the grid is not gated by it. */
export const SNAP_MAX_SPEED = 0.5;
/** Two boxes whose edges differ by less than this land on the same line: the snapped coordinates are exact binary64 values, and
 * this only absorbs the final addition of a delta to a position. */
const LAND_TOLERANCE = 1e-6;

/** Complete Scene strip traversal followed by actual logical geometry, never a hint or a prefix. */
export async function snapBoardBounds(options: BoardSnapOptions): Promise<BoardSnapResult> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), cooperate = options.cooperate ?? yieldToHost;
    const valid = () => !options.signal?.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && runtime.selection.getSnapshot() === selection;
    const objects = options.objects ?? true, grid = (options.grid ?? true) && boardSnapGrid(doc) !== null;
    if (!objects && !grid) return { delta: { x: 0, y: 0 }, guides: [] };
    for (;;) {
        options.signal?.throwIfAborted(); if (!valid()) throw new DOMException('Snap source changed', 'AbortError');
        const scene = runtime.scene; if (!scene) throw new Error('Snap scene is unavailable');
        while (!scene.ready) { options.signal?.throwIfAborted(); if (!valid()) throw new DOMException('Snap source changed', 'AbortError');
            scene.step(64, performance.now() + 3); await cooperate(); }
        const epoch = runtime.render.text.fonts.epoch;
        try { return await snapAttempt(options, objects, grid); }
        catch (error) {
            if (!valid()) throw error;
            if (runtime.render.text.fonts.epoch === epoch && scene.ready) throw error;
            // Font loads invalidate the index; repeat only after the actual Scene publishes its new bounds.
        }
    }
}

function span(rect: Readonly<Rect>, axis: Axis): [number, number] {
    return axis === 'x' ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
}
/** The overlap of two boxes across `axis`'s perpendicular; touching counts. */
function crossOverlap(a: Readonly<Rect>, b: Readonly<Rect>, axis: Axis): number {
    const perpendicular: Axis = axis === 'x' ? 'y' : 'x';
    const [a0, a1] = span(a, perpendicular), [b0, b1] = span(b, perpendicular);
    return Math.min(a1, b1) - Math.max(a0, b0);
}
/** The points of a box that lie on the line `value` of `axis`: its three features along the other axis. */
function featurePoints(rect: Readonly<Rect>, axis: Axis, value: number): Vec2[] {
    const along = axis === 'x' ? [rect.y, rect.y + rect.height / 2, rect.y + rect.height] : [rect.x, rect.x + rect.width / 2, rect.x + rect.width];
    return along.map(position => axis === 'x' ? { x: value, y: position } : { x: position, y: value });
}

/** The nearest outline point to `point` among the boxes it could reach. Figures and lines use their real outline in board space;
 * other boxes (notes, frames) use their box edges. A box whose outline is unknown is skipped rather than guessed. */
function nearestOutlinePoint(doc: BoardRuntime['session']['doc'], boxes: readonly Box[], point: Vec2, threshold: number):
    { readonly point: Vec2; readonly rank: number } | undefined {
    let best: { point: Vec2; rank: number; distance: number } | undefined;
    for (const box of boxes) {
        const r = box.rect;
        if (point.x < r.x - threshold || point.x > r.x + r.width + threshold || point.y < r.y - threshold || point.y > r.y + r.height + threshold) continue;
        const node = doc.nodes.get(box.id);
        let outline: readonly OutlinePolyline[] | null = null;
        if (node?.kind === 'figure') {
            const pose = worldPose(doc, box.id);
            outline = transformPolylines(contourPolylines(figureOutline(node.shape, node.w, node.h, node.flipX, node.flipY).primary), pose);
        } else if (node?.kind === 'polyline') {
            outline = transformPolylines([{ points: node.points, closed: false }], worldPose(doc, box.id));
        } else if (node?.kind === 'sticky' || node?.kind === 'frame') outline = rectOutline(r);
        if (!outline) continue;
        const near = nearestOnPolylines(point, outline);
        if (near && near.distance <= threshold && (!best || near.distance < best.distance)) best = { point: near.point, rank: box.rank, distance: near.distance };
    }
    return best && { point: best.point, rank: best.rank };
}

async function snapAttempt(options: BoardSnapOptions, objects: boolean, grid: boolean): Promise<BoardSnapResult> {
    const { runtime, bounds } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const state = runtime.selection.getSnapshot(), scene = runtime.scene, signal = options.signal ?? new AbortController().signal;
    const threshold = (options.thresholdCss ?? 8) / options.zoom, font = runtime.render.text.fonts.epoch;
    const cooperate = options.cooperate ?? yieldToHost;
    if (![bounds.x, bounds.y, bounds.width, bounds.height, bounds.x + bounds.width, bounds.y + bounds.height, options.zoom, threshold].every(Number.isFinite)
        || bounds.width < 0 || bounds.height < 0 || options.zoom <= 0 || threshold < 0) throw new RangeError('Invalid snapping bounds');
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || session.owner !== owner || session.doc !== doc || doc.rev !== revision
            || runtime.selection.getSnapshot() !== state || runtime.render.text.fonts.epoch !== font
            || !scene?.ready || scene.revision !== revision) throw new DOMException('Snap source changed', 'AbortError');
    };
    check();
    const xs = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
    const ys = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
    const candidates = objects ? await collectSnapCandidates({ runtime, scene: scene!, doc, sheet: state.sheet, focus: state.focus,
        selected: options.selected, bounds, threshold, signal, cooperate, current: () => { try { check(); return true; } catch { return false; } } }) : new Set<NodeId>();
    check();
    const lattice = grid ? boardSnapGrid(doc) : null;
    if (!candidates.size && !lattice) return { delta: { x: 0, y: 0 }, guides: [] };
    const scope = candidates.size ? await acquireBoardGeometryScope(runtime, candidates, { signal, cooperate, current: () => {
        try { check(); return true; } catch { return false; }
    } }) : null;
    try {
        check();
        const boxes: Box[] = [], visibility = createSnapVisibility(doc);
        let visited = 0;
        for (const id of candidates) {
            check(); if (++visited % 256 === 0) { await cooperate(); check(); }
            const logical = scope!.logicalBounds(id), relation = visibility(id, logical);
            if (relation === 'hidden') continue;
            const other = relation === 'partial' ? await prepareVisibleSnapBounds(doc, id, logical, { runtime, signal, cooperate,
                current: () => { try { check(); return true; } catch { return false; } } }) : logical;
            check(); if (!other) continue;
            boxes.push({ id, rect: other, rank: scope!.rank(id) });
        }
        const byId = new Map(boxes.map(box => [box.id, box]));
        const best: { x: Winner | undefined; y: Winner | undefined } = { x: undefined, y: undefined };
        const better = (candidate: Winner, old: Winner | undefined) => !old || compareSnapMagnitude(candidate.delta, old.delta) < 0
            || (compareSnapMagnitude(candidate.delta, old.delta) === 0 && (candidate.priority < old.priority
                || (candidate.priority === old.priority && (candidate.rank > old.rank
                    || (candidate.rank === old.rank && (candidate.source < old.source || (candidate.source === old.source && candidate.edge < old.edge)))))));
        const offer = (axis: Axis, winner: Winner) => { if (better(winner, best[axis])) best[axis] = winner; };
        if (objects && options.points) {
            // Points before anything else: the nearest point within the threshold in two dimensions, then both axes land on it.
            const pool: { readonly point: Vec2; readonly rank: number; readonly source: number }[] = [];
            for (const box of boxes) {
                const r = box.rect;
                const corners = [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x, y: r.y + r.height }, { x: r.x + r.width, y: r.y + r.height },
                    { x: r.x + r.width / 2, y: r.y + r.height / 2 }];
                corners.forEach((point, source) => pool.push({ point, rank: box.rank, source }));
            }
            (options.ownPoints ?? []).forEach((point, source) => pool.push({ point, rank: Number.MAX_SAFE_INTEGER, source }));
            let hit: { readonly point: Vec2; readonly rank: number } | undefined, hitDistance = Infinity;
            for (const entry of pool) {
                const distance = Math.hypot(entry.point.x - bounds.x, entry.point.y - bounds.y);
                if (!(distance <= threshold)) continue;
                if (distance < hitDistance || (distance === hitDistance && hit && entry.rank > hit.rank)) { hit = entry; hitDistance = distance; }
            }
            if (hit) {
                const dx = exactSnapDisplacement(hit.point.x, bounds.x), dy = exactSnapDisplacement(hit.point.y, bounds.y);
                if (dx.representable) offer('x', { delta: dx, rank: hit.rank, priority: 0, source: 0, edge: 0, target: hit.point.x });
                if (dy.representable) offer('y', { delta: dy, rank: hit.rank, priority: 0, source: 0, edge: 0, target: hit.point.y });
            } else if (options.outline) {
                // No point is in reach, so the handle may land on an edge: the nearest outline point within the same threshold.
                const edge = nearestOutlinePoint(doc, boxes, bounds, threshold);
                if (edge) {
                    const dx = exactSnapDisplacement(edge.point.x, bounds.x), dy = exactSnapDisplacement(edge.point.y, bounds.y);
                    if (dx.representable) offer('x', { delta: dx, rank: edge.rank, priority: 0, source: 0, edge: 0, target: edge.point.x });
                    if (dy.representable) offer('y', { delta: dy, rank: edge.rank, priority: 0, source: 0, edge: 0, target: edge.point.y });
                }
            }
        } else if (objects) {
            for (const box of boxes) {
                check();
                const r = box.rect;
                for (const [axis, own, target] of [
                    ['x', xs, [r.x, r.x + r.width / 2, r.x + r.width]],
                    ['y', ys, [r.y, r.y + r.height / 2, r.y + r.height]],
                ] as const) {
                    for (let i = 0; i < own.length; i++) for (let j = 0; j < target.length; j++) {
                        const delta = exactSnapDisplacement(target[j], own[i]);
                        if (!delta.representable || !snapWithin(delta, threshold)) continue;
                        offer(axis, { delta, rank: box.rank, priority: 0, source: i, edge: j });
                    }
                }
            }
            if (options.gaps ?? true) for (const axis of ['x', 'y'] as const) gapOffers(axis, bounds, boxes, threshold, offer);
        }
        if (options.allowX === false) best.x = undefined;
        if (options.allowY === false) best.y = undefined;
        // A gap's anchors must still overlap the moved box across the other axis after both corrections. Dropping one can
        // only move the box, so repeat until nothing is dropped; a stale gap is never published.
        for (let pass = 0; pass < 3; pass++) {
            const box = { x: bounds.x + (best.x?.delta.rounded ?? 0), y: bounds.y + (best.y?.delta.rounded ?? 0), width: bounds.width, height: bounds.height };
            let dropped = false;
            for (const axis of ['x', 'y'] as const) {
                const winner = best[axis];
                if (!winner?.gap) continue;
                const anchors = winner.gap.kind === 'centre' ? winner.gap.anchors : [winner.gap.anchors[0]];
                const usable = anchors.every(id => { const anchor = byId.get(id); return !!anchor && crossOverlap(anchor.rect, box, axis) >= 0; });
                if (!usable) { best[axis] = undefined; dropped = true; }
            }
            if (!dropped) break;
        }
        // Object snaps beat the grid: the lattice is only consulted when no object snap survives on either axis.
        if (!best.x && !best.y && lattice) {
            for (const [axis, features, origin, step] of [
                ['x', xs, lattice.origin.x, lattice.step.x],
                ['y', ys, lattice.origin.y, lattice.step.y],
            ] as const) {
                if (options.allowX === false && axis === 'x') continue;
                if (options.allowY === false && axis === 'y') continue;
                for (let source = 0; source < features.length; source++) {
                    const cell = nearestBoardGridCoordinate(features[source], origin, step);
                    if (!snapWithin(cell.delta, threshold)) continue;
                    offer(axis, { delta: cell.delta, rank: -1, priority: 2, source, edge: 0,
                        grid: { value: cell.coordinate, representable: cell.coordinateRepresentable } });
                }
            }
        }
        const x = best.x, y = best.y;
        if ((x && !x.delta.representable) || (y && !y.delta.representable)) throw new RangeError('Snap displacement is not exactly representable');
        if ((x?.grid && !x.grid.representable) || (y?.grid && !y.grid.representable)) throw new RangeError('Snap grid coordinate is not exactly representable');
        const dx = x?.delta.rounded ?? 0, dy = y?.delta.rounded ?? 0;
        const final: Rect = { x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height };
        const guides: BoardSnapGuide[] = [];
        // Every alignment that lands exactly after the snap, merged per line: ties accumulate, one line each, with its crosses.
        const lines = new Map<string, { axis: Axis; value: number; from: number; to: number; target: NodeId | undefined; marks: Vec2[]; keys: Set<string> }>();
        const targets: { readonly rect: Readonly<Rect>; readonly id?: NodeId }[] = [
            ...boxes.map(box => ({ rect: box.rect, id: box.id })),
            ...(objects && options.points ? (options.ownPoints ?? []) : []).map(point => ({ rect: { x: point.x, y: point.y, width: 0, height: 0 } })),
        ];
        for (const target of targets) {
            check();
            for (const axis of ['x', 'y'] as const) {
                const own = axis === 'x' ? [final.x, final.x + final.width / 2, final.x + final.width] : [final.y, final.y + final.height / 2, final.y + final.height];
                const features = axis === 'x' ? [target.rect.x, target.rect.x + target.rect.width / 2, target.rect.x + target.rect.width] : [target.rect.y, target.rect.y + target.rect.height / 2, target.rect.y + target.rect.height];
                for (const value of features) {
                    if (!own.some(feature => Math.abs(feature - value) <= LAND_TOLERANCE)) continue;
                    const key = `${axis}:${value}`;
                    let line = lines.get(key);
                    if (!line) { line = { axis, value, from: Infinity, to: -Infinity, target: target.id, marks: [], keys: new Set() }; lines.set(key, line); }
                    const across = axis === 'x' ? 'y' : 'x', [b0, b1] = span(target.rect, across), [f0, f1] = span(final, across);
                    line.from = Math.min(line.from, b0, f0); line.to = Math.max(line.to, b1, f1);
                    for (const point of [...featurePoints(final, axis, value), ...featurePoints(target.rect, axis, value)]) {
                        const mark = `${point.x}|${point.y}`;
                        if (!line.keys.has(mark)) { line.keys.add(mark); line.marks.push(point); }
                    }
                }
            }
        }
        for (const line of lines.values()) {
            guides.push({ axis: line.axis, value: line.value, from: line.from, to: line.to, target: line.target, kind: 'alignment', marks: line.marks });
        }
        for (const axis of ['x', 'y'] as const) {
            const winner = best[axis];
            if (winner?.gap) guides.push(...gapGuides(winner.gap, axis, final, byId));
        }
        if (x?.grid) guides.push({ axis: 'x', value: x.grid.value, kind: 'grid', from: bounds.y + dy, to: bounds.y + dy + bounds.height });
        if (y?.grid) guides.push({ axis: 'y', value: y.grid.value, kind: 'grid', from: bounds.x + dx, to: bounds.x + dx + bounds.width });
        if (guides.some(guide => ![guide.value, guide.from, guide.to].every(Number.isFinite))) throw new RangeError('Snap guide overflows');
        check(); return { delta: { x: dx, y: dy }, guides, landed: { x: x?.target, y: y?.target } };
    } finally { scope?.release(); }
}

/** Gap offers along one axis: a centre (the moved box fits between two boxes) and duplicates (it repeats a gap between
 * two other boxes that overlap each other across the axis). Only boxes sharing a cross-axis range with the moved box
 * can be anchors. */
function gapOffers(axis: Axis, bounds: Readonly<Rect>, boxes: readonly Box[], threshold: number,
    offer: (axis: Axis, winner: Winner) => void): void {
    const m0 = span(bounds, axis)[0], size = axis === 'x' ? bounds.width : bounds.height;
    const near = boxes.filter(box => crossOverlap(box.rect, bounds, axis) >= 0);
    for (const a of near) for (const b of near) {
        if (a === b) continue;
        const a1 = span(a.rect, axis)[1], b0 = span(b.rect, axis)[0];
        if (a1 > b0 || crossOverlap(a.rect, b.rect, axis) < 0) continue;
        const delta = exactGapDisplacement(a1, b0, size, m0);
        if (!delta || !delta.representable || !snapWithin(delta, threshold)) continue;
        offer(axis, { delta, rank: Math.max(a.rank, b.rank), priority: 1, source: 0, edge: 0,
            gap: { kind: 'centre', anchors: [a.id, b.id] } });
    }
    // One exact gap per distinct size, from any pair of boxes that overlap across the axis.
    const gaps = new Map<number, { readonly gap: Dyadic; readonly a: Box; readonly b: Box }>();
    for (const a of boxes) for (const b of boxes) {
        if (a === b) continue;
        const a1 = span(a.rect, axis)[1], b0 = span(b.rect, axis)[0];
        if (a1 > b0 || crossOverlap(a.rect, b.rect, axis) < 0 || b0 - a1 <= 0) continue;
        if (!gaps.has(b0 - a1)) gaps.set(b0 - a1, { gap: exactGapSize(a1, b0), a, b });
    }
    for (const { gap, a, b } of gaps.values()) for (const neighbour of near) {
        const [n0, n1] = span(neighbour.rect, axis);
        const anchors = [neighbour.id, a.id, b.id];
        const rank = Math.max(neighbour.rank, a.rank, b.rank);
        if (n1 <= m0) {
            const delta = exactDuplicateDisplacement(n1, gap, m0, size, 'after');
            if (delta.representable && snapWithin(delta, threshold)) offer(axis, { delta, rank, priority: 1, source: 0, edge: 0, gap: { kind: 'duplicate-after', anchors } });
        }
        if (n0 >= m0 + size) {
            const delta = exactDuplicateDisplacement(n0, gap, m0, size, 'before');
            if (delta.representable && snapWithin(delta, threshold)) offer(axis, { delta, rank, priority: 1, source: 0, edge: 0, gap: { kind: 'duplicate-before', anchors } });
        }
    }
}

/** The guide segments for a winning gap: both sides of a centre; the new gap and the reference gap of a duplicate.
 * Drawn across the shared range of the boxes involved, at its middle, so the line sits inside every box it describes. */
function gapGuides(gap: GapFact, axis: Axis, final: Readonly<Rect>, byId: ReadonlyMap<NodeId, Box>): BoardSnapGuide[] {
    const rect = (id: NodeId) => byId.get(id)!.rect;
    const [f0, f1] = span(final, axis);
    const segments: [number, number][] = [];
    let involved: Readonly<Rect>[];
    if (gap.kind === 'centre') {
        const [, left1] = span(rect(gap.anchors[0]), axis), [right0] = span(rect(gap.anchors[1]), axis);
        segments.push([left1, f0], [f1, right0]);
        involved = [rect(gap.anchors[0]), final, rect(gap.anchors[1])];
    } else {
        const [neighbour0, neighbour1] = span(rect(gap.anchors[0]), axis);
        const referenceFirst = span(rect(gap.anchors[1]), axis)[1], referenceSecond = span(rect(gap.anchors[2]), axis)[0];
        segments.push(gap.kind === 'duplicate-after' ? [neighbour1, f0] : [f1, neighbour0]);
        segments.push([referenceFirst, referenceSecond]);
        involved = [rect(gap.anchors[0]), final, rect(gap.anchors[1]), rect(gap.anchors[2])];
    }
    const across = axis === 'x' ? 'y' : 'x';
    let lo = -Infinity, hi = Infinity;
    for (const r of involved) { const [a0, a1] = span(r, across); lo = Math.max(lo, a0); hi = Math.min(hi, a1); }
    const value = lo <= hi ? (lo + hi) / 2 : span(final, across)[0] + span(final, across)[1] / 2;
    return segments.map(([from, to]) => ({ axis: across, value, from, to, kind: 'equal-gap' as const, featureAxis: axis }));
}
