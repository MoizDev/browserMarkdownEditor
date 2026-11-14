import { isLocked } from '../change/commands';
import { worldPose } from '../change/coordinates';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { FrameNode } from '../model/nodes';
import type { SpatialRef } from '../pick';
import { BoundsQuality } from '../scene/bounds';
import { boardFrameAncestors } from './ancestorFrames';
import { pointInTransformedFrame } from './frameContainment';
import type { Vec2 } from './path';

export interface FrameMembershipCentre { readonly id: NodeId; readonly parent: ParentId; readonly point: Vec2 }
export interface FrameMembershipTarget { readonly id: NodeId; readonly rank: number }
function contains(doc: BoardDoc, frame: Readonly<FrameNode>, point: Vec2): boolean {
    const pose = worldPose(doc, frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return pointInTransformedFrame(point, { x: 0, y: 0, width: frame.w, height: frame.h }, [c, s, -s, c, pose.x, pose.y]);
}
function selectedAncestor(doc: BoardDoc, id: NodeId, selected: ReadonlySet<NodeId>): boolean {
    let parent: ParentId = id; const seen = new Set<NodeId>();
    for (let depth = 0; depth <= 64; depth++) {
        if (isSheetParent(doc, parent)) return false;
        const key = parent as NodeId; if (selected.has(key)) return true;
        if (seen.has(key)) throw new RangeError('Frame candidate ancestry contains a cycle');
        seen.add(key); const node = doc.nodes.get(key); if (!node) throw new Error('Frame candidate ancestor disappeared');
        parent = node.parent;
    }
    throw new RangeError('Frame candidate ancestry exceeds its depth limit');
}
function visible(doc: BoardDoc, frame: Readonly<FrameNode>, point: Vec2): boolean {
    if (!contains(doc, frame, point)) return false;
    for (const ancestor of boardFrameAncestors(doc, frame)) if (!contains(doc, ancestor, point)) return false;
    return true;
}

/** One bounded Scene traversal serves every moved root. Centres are grouped by
 * destination parent and x-sorted so a large frame does not rescan the board. */
export async function findFrameMembershipTargets(options: {
    readonly runtime: BoardRuntime; readonly scene: NonNullable<BoardRuntime['scene']>; readonly doc: BoardDoc; readonly sheet: SheetId;
    readonly centres: readonly FrameMembershipCentre[]; readonly selected: ReadonlySet<NodeId>; readonly signal: AbortSignal;
    readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<ReadonlyMap<NodeId, FrameMembershipTarget>> {
    const { scene, doc, signal } = options, revision = scene.revision;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let work = 0, started = performance.now();
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || options.runtime.scene !== scene || !scene.ready || scene.revision !== revision)
            throw new DOMException('Frame membership candidates became stale', 'AbortError');
    };
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const groups = new Map<ParentId, FrameMembershipCentre[]>(), result = new Map<NodeId, FrameMembershipTarget>();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const centre of options.centres) {
        check(); if (![centre.point.x, centre.point.y].every(Number.isFinite)) throw new RangeError('Frame membership centre is invalid');
        const bucket = groups.get(centre.parent); if (bucket) bucket.push(centre); else groups.set(centre.parent, [centre]);
        x0 = Math.min(x0, centre.point.x); y0 = Math.min(y0, centre.point.y); x1 = Math.max(x1, centre.point.x); y1 = Math.max(y1, centre.point.y);
        if (due()) await tick();
    }
    if (!options.centres.length) return result;
    for (const [parent, bucket] of groups) {
        let values = bucket, buffer = new Array<FrameMembershipCentre>(bucket.length);
        for (let width = 1; width < values.length; width *= 2) {
            for (let start = 0; start < values.length; start += width * 2) {
                const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
                let left = start, right = middle;
                for (let i = start; i < end; i++) {
                    buffer[i] = left < middle && (right >= end || values[left].point.x <= values[right].point.x) ? values[left++] : values[right++];
                    if (due()) await tick();
                }
            }
            [values, buffer] = [buffer, values];
        }
        groups.set(parent, values);
    }
    const cursor = scene.spatialCursor({ sheetId: options.sheet, purpose: 'selectable', includeLocked: true,
        request: { kind: 'box', box: [x0, y0, x1, y1] } });
    let complete = false, index = 0; const refs: SpatialRef[] = [];
    try {
        while (!complete || index < refs.length) {
            check();
            if (index === refs.length && !complete) {
                refs.length = 0; index = 0;
                const state = cursor.resume({ maxVisits: 128, deadline: performance.now() + 3 }, ref => refs.push(ref));
                if (state === 'cancelled' || state === 'stale') throw new DOMException('Frame candidate traversal expired', 'AbortError');
                complete = state === 'complete';
            }
            const ref = index < refs.length ? refs[index++] : undefined;
            if (!ref) { if (!complete) await tick(); continue; }
            const resolved = scene.resolveSpatial(ref); if (!resolved) throw new DOMException('Frame candidate expired', 'AbortError');
            const candidate = doc.nodes.get(resolved.id);
            if (!candidate) throw new DOMException('Frame candidate disappeared', 'AbortError');
            if (candidate.kind !== 'frame' || isLocked(doc, candidate) || selectedAncestor(doc, candidate.id, options.selected)) { if (due()) await tick(); continue; }
            const bucket = groups.get(candidate.parent); if (!bucket?.length) { if (due()) await tick(); continue; }
            const record = scene.worldBounds(candidate.id), raw = record && (record.quality === BoundsQuality.Exact || record.quality === BoundsQuality.Conservative)
                ? record.selectable : null;
            const bounds = raw && raw.every(Number.isFinite) ? raw : null;
            let start = 0, end = bucket.length;
            if (bounds) {
                let lo = 0, hi = bucket.length;
                while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (bucket[mid].point.x < bounds[0]) lo = mid + 1; else hi = mid; }
                start = lo; lo = start; hi = bucket.length;
                while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (bucket[mid].point.x <= bounds[2]) lo = mid + 1; else hi = mid; }
                end = lo;
            }
            for (let i = start; i < end; i++) {
                const centre = bucket[i], old = result.get(centre.id);
                if ((!bounds || (centre.point.y >= bounds[1] && centre.point.y <= bounds[3]))
                    && (!old || resolved.rank > old.rank || (resolved.rank === old.rank && resolved.id < old.id))
                    && visible(doc, candidate, centre.point)) result.set(centre.id, { id: resolved.id, rank: resolved.rank });
                if (due()) await tick();
            }
        }
    } finally { cursor.cancel(); }
    check(); return result;
}
