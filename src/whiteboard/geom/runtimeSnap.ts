import type { Rect } from '../../platform/types';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { Vec2 } from './path';

export interface BoardSnapGuide {
    readonly axis: 'x' | 'y';
    readonly value: number;
    readonly from: number;
    readonly to: number;
    readonly target: NodeId;
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
}
interface Winner { readonly delta: number; readonly guide: BoardSnapGuide; readonly rank: number; readonly source: number; readonly edge: number }

/** Complete Scene strip traversal followed by actual logical geometry, never a hint or a prefix. */
export async function snapBoardBounds(options: BoardSnapOptions): Promise<BoardSnapResult> {
    const { runtime, bounds } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const state = runtime.selection.getSnapshot(), scene = runtime.scene, signal = options.signal ?? new AbortController().signal;
    const threshold = (options.thresholdCss ?? 8) / options.zoom, font = runtime.render.text.fonts.epoch;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    if (![bounds.x, bounds.y, bounds.width, bounds.height, options.zoom, threshold].every(Number.isFinite)
        || bounds.width < 0 || bounds.height < 0 || options.zoom <= 0 || threshold < 0) throw new RangeError('Invalid snapping bounds');
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || session.owner !== owner || session.doc !== doc || doc.rev !== revision
            || runtime.selection.getSnapshot() !== state || runtime.render.text.fonts.epoch !== font
            || !scene?.ready || scene.revision !== revision) throw new DOMException('Snap source changed', 'AbortError');
    };
    check();
    const selected = new Set(options.selected), ancestors = new Set<NodeId>();
    for (const id of selected) {
        let node = doc.nodes.get(id);
        for (let depth = 0; node && depth < 64; depth++) { ancestors.add(node.id); node = doc.nodes.get(node.parent as NodeId); }
    }
    const excluded = (id: NodeId) => {
        if (ancestors.has(id)) return true;
        let node = doc.nodes.get(id);
        for (let depth = 0; node && depth < 64; depth++) { if (selected.has(node.id)) return true; node = doc.nodes.get(node.parent as NodeId); }
        return false;
    };
    const xs = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
    const ys = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
    const candidates = new Set<NodeId>();
    for (const [axis, values] of [['x', xs], ['y', ys]] as const) for (const value of values) {
        check();
        const cursor = scene!.spatialCursor({ sheetId: state.sheet, purpose: 'selectable', request: { kind: 'strip', axis, value, maxDistance: threshold } });
        try {
            for (;;) {
                check();
                const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 256 }, ref => {
                    const resolved = scene!.resolveSpatial(ref);
                    if (!resolved) throw new DOMException('Snap candidate expired', 'AbortError');
                    if (!excluded(resolved.id)) candidates.add(resolved.id);
                });
                if (status === 'complete') break;
                if (status !== 'pending') throw new DOMException('Snap traversal expired', 'AbortError');
                await cooperate();
            }
        } finally { cursor.cancel(); }
    }
    check();
    if (!candidates.size) return { delta: { x: 0, y: 0 }, guides: [] };
    const scope = await acquireBoardGeometryScope(runtime, candidates, { signal, cooperate, current: () => {
        try { check(); return true; } catch { return false; }
    } });
    try {
        check(); let x: Winner | undefined, y: Winner | undefined;
        const better = (candidate: Winner, old: Winner | undefined) => !old || Math.abs(candidate.delta) < Math.abs(old.delta)
            || (Math.abs(candidate.delta) === Math.abs(old.delta) && (candidate.rank > old.rank
                || (candidate.rank === old.rank && (candidate.source < old.source || (candidate.source === old.source && candidate.edge < old.edge)))));
        for (const id of candidates) {
            check(); const other = scope.logicalBounds(id), rank = scope.rank(id);
            for (const [axis, own, target] of [
                ['x', xs, [other.x, other.x + other.width / 2, other.x + other.width]],
                ['y', ys, [other.y, other.y + other.height / 2, other.y + other.height]],
            ] as const) {
                for (let i = 0; i < own.length; i++) for (let j = 0; j < target.length; j++) {
                    const delta = target[j] - own[i]; if (Math.abs(delta) > threshold) continue;
                    const guide: BoardSnapGuide = { axis, value: target[j], target: id,
                        from: axis === 'x' ? Math.min(bounds.y, other.y) : Math.min(bounds.x, other.x),
                        to: axis === 'x' ? Math.max(bounds.y + bounds.height, other.y + other.height) : Math.max(bounds.x + bounds.width, other.x + other.width) };
                    const winner = { delta, guide, rank, source: i, edge: j };
                    if (axis === 'x') { if (better(winner, x)) x = winner; }
                    else if (better(winner, y)) y = winner;
                }
            }
        }
        check(); return { delta: { x: x?.delta ?? 0, y: y?.delta ?? 0 }, guides: [x?.guide, y?.guide].filter((guide): guide is BoardSnapGuide => !!guide) };
    } finally { scope.release(); }
}
