import type { Rect } from '../../platform/types';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Vec2 } from './path';
import { collectSnapCandidates, createSnapVisibility } from './snapCandidates';
import { prepareVisibleSnapBounds } from './snapVisibleBounds';

export interface BoardSnapGuide {
    readonly axis: 'x' | 'y';
    readonly value: number;
    readonly from: number;
    readonly to: number;
    readonly target: NodeId;
    readonly kind?: 'alignment' | 'equal-gap';
    readonly featureAxis?: 'x' | 'y';
}
export interface BoardSnapResult { readonly delta: Vec2; readonly guides: readonly BoardSnapGuide[] }
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
}
interface Winner { readonly delta: number; readonly guides: readonly BoardSnapGuide[]; readonly rank: number; readonly priority: number; readonly source: number; readonly edge: number }

/** Complete Scene strip traversal followed by actual logical geometry, never a hint or a prefix. */
export async function snapBoardBounds(options: BoardSnapOptions): Promise<BoardSnapResult> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const valid = () => !options.signal?.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && runtime.selection.getSnapshot() === selection;
    for (;;) {
        options.signal?.throwIfAborted(); if (!valid()) throw new DOMException('Snap source changed', 'AbortError');
        const scene = runtime.scene; if (!scene) throw new Error('Snap scene is unavailable');
        while (!scene.ready) { options.signal?.throwIfAborted(); if (!valid()) throw new DOMException('Snap source changed', 'AbortError');
            scene.step(64, performance.now() + 3); await cooperate(); }
        const epoch = runtime.render.text.fonts.epoch;
        try { return await snapAttempt(options); }
        catch (error) {
            if (!valid()) throw error;
            if (runtime.render.text.fonts.epoch === epoch && scene.ready) throw error;
            // Font loads invalidate the index; repeat only after the actual Scene publishes its new bounds.
        }
    }
}

async function snapAttempt(options: BoardSnapOptions): Promise<BoardSnapResult> {
    const { runtime, bounds } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const state = runtime.selection.getSnapshot(), scene = runtime.scene, signal = options.signal ?? new AbortController().signal;
    const threshold = (options.thresholdCss ?? 8) / options.zoom, font = runtime.render.text.fonts.epoch;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
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
    const candidates = await collectSnapCandidates({ runtime, scene: scene!, doc, sheet: state.sheet, focus: state.focus,
        selected: options.selected, bounds, threshold, signal, cooperate, current: () => { try { check(); return true; } catch { return false; } } });
    check();
    if (!candidates.size) return { delta: { x: 0, y: 0 }, guides: [] };
    const scope = await acquireBoardGeometryScope(runtime, candidates, { signal, cooperate, current: () => {
        try { check(); return true; } catch { return false; }
    } });
    try {
        check(); let x: Winner | undefined, y: Winner | undefined;
        const better = (candidate: Winner, old: Winner | undefined) => !old || Math.abs(candidate.delta) < Math.abs(old.delta)
            || (Math.abs(candidate.delta) === Math.abs(old.delta) && (candidate.priority < old.priority
                || (candidate.priority === old.priority && (candidate.rank > old.rank
                    || (candidate.rank === old.rank && (candidate.source < old.source || (candidate.source === old.source && candidate.edge < old.edge)))))));
        type Neighbour = { readonly id: NodeId; readonly edge: number; readonly distance: number; readonly rank: number };
        let left: Neighbour | undefined, right: Neighbour | undefined, above: Neighbour | undefined, below: Neighbour | undefined;
        const candidateBounds: Readonly<Rect>[] = [];
        const nearer = (value: Neighbour, old: Neighbour | undefined) => !old || value.distance < old.distance
            || (value.distance === old.distance && (value.rank > old.rank || (value.rank === old.rank && value.id < old.id)));
        let visited = 0; const visibility = createSnapVisibility(doc);
        for (const id of candidates) {
            check(); if (++visited % 256 === 0) { await cooperate(); check(); }
            const logical = scope.logicalBounds(id), relation = visibility(id, logical);
            if (relation === 'hidden') continue;
            const other = relation === 'partial' ? await prepareVisibleSnapBounds(doc, id, logical, { signal, cooperate,
                current: () => { try { check(); return true; } catch { return false; } } }) : logical;
            check(); if (!other) continue;
            const rank = scope.rank(id); candidateBounds.push(other);
            const overlapY = Math.min(other.y + other.height, bounds.y + bounds.height) - Math.max(other.y, bounds.y);
            const overlapX = Math.min(other.x + other.width, bounds.x + bounds.width) - Math.max(other.x, bounds.x);
            if (overlapY >= 0) {
                if (other.x + other.width <= bounds.x) { const value = { id, edge: other.x + other.width, distance: bounds.x - other.x - other.width, rank }; if (nearer(value, left)) left = value; }
                if (other.x >= bounds.x + bounds.width) { const value = { id, edge: other.x, distance: other.x - bounds.x - bounds.width, rank }; if (nearer(value, right)) right = value; }
            }
            if (overlapX >= 0) {
                if (other.y + other.height <= bounds.y) { const value = { id, edge: other.y + other.height, distance: bounds.y - other.y - other.height, rank }; if (nearer(value, above)) above = value; }
                if (other.y >= bounds.y + bounds.height) { const value = { id, edge: other.y, distance: other.y - bounds.y - bounds.height, rank }; if (nearer(value, below)) below = value; }
            }
            for (const [axis, own, target] of [
                ['x', xs, [other.x, other.x + other.width / 2, other.x + other.width]],
                ['y', ys, [other.y, other.y + other.height / 2, other.y + other.height]],
            ] as const) {
                for (let i = 0; i < own.length; i++) for (let j = 0; j < target.length; j++) {
                    const delta = target[j] - own[i]; if (Math.abs(delta) > threshold) continue;
                    const guide: BoardSnapGuide = { axis, value: target[j], target: id,
                        from: axis === 'x' ? Math.min(bounds.y, other.y) : Math.min(bounds.x, other.x),
                        to: axis === 'x' ? Math.max(bounds.y + bounds.height, other.y + other.height) : Math.max(bounds.x + bounds.width, other.x + other.width) };
                    const winner = { delta, guides: [guide], rank, priority: 0, source: i, edge: j };
                    if (axis === 'x') { if (better(winner, x)) x = winner; }
                    else if (better(winner, y)) y = winner;
                }
            }
        }
        if (left && right) {
            const gap = (right.edge / 2 - left.edge / 2) - bounds.width / 2, delta = left.edge + gap - bounds.x;
            if (!Number.isFinite(gap) || !Number.isFinite(delta)) throw new RangeError('Horizontal snap gap overflows');
            if (gap >= 0 && Math.abs(delta) <= threshold) {
                const value = bounds.y + bounds.height / 2;
                const winner: Winner = { delta, rank: Math.max(left.rank, right.rank), priority: 1, source: 0, edge: 0,
                    guides: [{ axis: 'y', value, from: left.edge, to: bounds.x + delta, target: left.id, kind: 'equal-gap', featureAxis: 'x' },
                        { axis: 'y', value, from: bounds.x + delta + bounds.width, to: right.edge, target: right.id, kind: 'equal-gap', featureAxis: 'x' }] };
                if (better(winner, x)) x = winner;
            }
        }
        if (above && below) {
            const gap = (below.edge / 2 - above.edge / 2) - bounds.height / 2, delta = above.edge + gap - bounds.y;
            if (!Number.isFinite(gap) || !Number.isFinite(delta)) throw new RangeError('Vertical snap gap overflows');
            if (gap >= 0 && Math.abs(delta) <= threshold) {
                const value = bounds.x + bounds.width / 2;
                const winner: Winner = { delta, rank: Math.max(above.rank, below.rank), priority: 1, source: 0, edge: 0,
                    guides: [{ axis: 'x', value, from: above.edge, to: bounds.y + delta, target: above.id, kind: 'equal-gap', featureAxis: 'y' },
                        { axis: 'x', value, from: bounds.y + delta + bounds.height, to: below.edge, target: below.id, kind: 'equal-gap', featureAxis: 'y' }] };
                if (better(winner, y)) y = winner;
            }
        }
        if (options.allowX === false) x = undefined;
        if (options.allowY === false) y = undefined;
        const dx = x?.delta ?? 0, dy = y?.delta ?? 0;
        const flank = (other: Readonly<Rect>, axis: 'x' | 'y', mx: number, my: number): -1 | 0 | 1 => {
            const horizontal = axis === 'x', start = horizontal ? bounds.x + mx : bounds.y + my;
            const extent = horizontal ? bounds.width : bounds.height, perpendicular = horizontal ? bounds.y + my : bounds.x + mx;
            const perpendicularExtent = horizontal ? bounds.height : bounds.width, otherStart = horizontal ? other.x : other.y;
            const otherExtent = horizontal ? other.width : other.height, otherPerpendicular = horizontal ? other.y : other.x;
            const otherPerpendicularExtent = horizontal ? other.height : other.width;
            if (otherPerpendicular > perpendicular + perpendicularExtent || otherPerpendicular + otherPerpendicularExtent < perpendicular) return 0;
            if (otherStart + otherExtent <= start) return -1;
            if (otherStart >= start + extent) return 1;
            return 0;
        };
        // If the other correction changes a flanking set, the previous nearest-neighbour
        // proof is no longer valid; never publish that provisional winner as exact.
        for (const other of candidateBounds) {
            if ((x?.priority === 1 && flank(other, 'x', 0, 0) !== flank(other, 'x', dx, dy))
                || (y?.priority === 1 && flank(other, 'y', 0, 0) !== flank(other, 'y', dx, dy)))
                throw new Error('Snap gap neighbours changed during simultaneous correction');
            if (++visited % 256 === 0) { await cooperate(); check(); }
        }
        check(); return { delta: { x: dx, y: dy }, guides: [...(x?.guides ?? []), ...(y?.guides ?? [])] };
    } finally { scope.release(); }
}
