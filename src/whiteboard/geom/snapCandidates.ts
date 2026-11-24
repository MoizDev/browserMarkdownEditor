import type { Rect } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, isSheetParent, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { SpatialRef } from '../pick';
import { selectableAtFocus } from '../selection';
import { boardFrameAncestors } from './ancestorFrames';
import { classifyCertifiedClipBox, preparePointClip, type CertifiedClipRegion } from './clippedPointPathJob';
import type { PathOp } from './path';

function ancestorChain(doc: BoardDoc, id: NodeId): NodeId[] {
    const chain: NodeId[] = [], seen = new Set<NodeId>(); let parent: ParentId = id;
    for (let depth = 0; depth <= 64; depth++) {
        if (isSheetParent(doc, parent)) return chain;
        const key = parent as NodeId; if (seen.has(key)) throw new RangeError('Snap hierarchy contains a cycle');
        seen.add(key); const node = doc.nodes.get(key); if (!node) throw new Error('Snap hierarchy ancestor disappeared');
        chain.push(key); parent = node.parent;
    }
    throw new RangeError('Snap hierarchy exceeds its depth limit');
}
function rectPath(w: number, h: number): readonly PathOp[] {
    return [{ op: 'M', p: { x: 0, y: 0 } }, { op: 'L', p: { x: w, y: 0 } },
        { op: 'L', p: { x: w, y: h } }, { op: 'L', p: { x: 0, y: h } }, { op: 'Z' }];
}

/** Collect complete Scene strips while respecting focus promotion and selected
 * subtree exclusion. Candidate resolution is sliced outside cursor callbacks. */
export async function collectSnapCandidates(options: {
    readonly runtime: BoardRuntime; readonly scene: NonNullable<BoardRuntime['scene']>; readonly doc: BoardDoc;
    readonly sheet: SheetId; readonly focus: ParentId; readonly selected: readonly NodeId[]; readonly bounds: Rect; readonly threshold: number;
    readonly signal: AbortSignal; readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<ReadonlySet<NodeId>> {
    const { scene, doc, bounds, threshold } = options, revision = doc.rev, cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const check = () => { options.signal.throwIfAborted(); if (!options.current() || options.runtime.scene !== scene || !scene.ready || scene.revision !== revision || doc.rev !== revision)
        throw new DOMException('Snap candidate source changed', 'AbortError'); };
    let work = 0, started = performance.now();
    const due = () => ++work >= 256 || performance.now() - started >= 3;
    const tick = async () => { check(); await cooperate(); check(); work = 0; started = performance.now(); };
    const selected = new Set<NodeId>();
    for (const id of options.selected) { selected.add(id); if (due()) await tick(); }
    // The selection's own subtree never snaps to itself. Its ancestor frames do stay targets (a child lines up with its
    // frame's edges), while its ancestor groups are not targets: a group is recursed into, so its members are.
    const excluded = (id: NodeId) => selected.has(id) || ancestorChain(doc, id).some(ancestor => selected.has(ancestor));
    const xs = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
    const ys = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
    const strips: { axis: 'x' | 'y'; value: number; maxDistance: number }[] = [];
    for (const value of xs) strips.push({ axis: 'x', value, maxDistance: threshold });
    for (const value of ys) strips.push({ axis: 'y', value, maxDistance: threshold });
    // Default, calibration cut by owner: equal-gap candidates require perpendicular overlap.
    strips.push({ axis: 'y', value: bounds.y + bounds.height / 2, maxDistance: bounds.height / 2 + threshold },
        { axis: 'x', value: bounds.x + bounds.width / 2, maxDistance: bounds.width / 2 + threshold });
    const candidates = new Set<NodeId>();
    // A group is never a snap target as a whole: its members are, and a connector (arrow) is never a target at all.
    const snapLeaves = function* (id: NodeId): Generator<NodeId> {
        const pending: NodeId[] = [id];
        for (let guard = 0; pending.length && guard < 100_000; guard++) {
            const next = pending.pop()!, node = doc.nodes.get(next);
            if (!node || node.kind === 'connector') continue;
            if (node.kind === 'group') { for (const child of childrenOf(doc, node.id)) pending.push(child.id as NodeId); continue; }
            yield next;
        }
    };
    for (const strip of strips) {
        check();
        const cursor = scene.spatialCursor({ sheetId: options.sheet, purpose: 'selectable', request: { kind: 'strip', ...strip } });
        const refs: SpatialRef[] = []; let complete = false, index = 0;
        try {
            while (!complete || index < refs.length) {
                check();
                if (index === refs.length && !complete) {
                    refs.length = 0; index = 0;
                    const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 128 }, ref => refs.push(ref));
                    if (status === 'stale' || status === 'cancelled') throw new DOMException('Snap traversal expired', 'AbortError');
                    complete = status === 'complete';
                }
                const ref = index < refs.length ? refs[index++] : undefined;
                if (ref) {
                    const resolved = scene.resolveSpatial(ref); if (!resolved) throw new DOMException('Snap candidate expired', 'AbortError');
                    const promoted = selectableAtFocus(doc, resolved.id, options.focus, options.sheet);
                    if (promoted) for (const id of snapLeaves(promoted)) { if (!excluded(id)) candidates.add(id); if (due()) await tick(); }
                }
                if (due() || (!ref && !complete)) await tick();
            }
        } finally { cursor.cancel(); }
    }
    check(); return candidates;
}

/** Logical boxes wholly inside all inherited frames are exact snap inputs.
 * A partial box is not a surrogate for visible geometry and must be refused. */
export function createSnapVisibility(doc: BoardDoc): (id: NodeId, bounds: Readonly<Rect>) => 'visible' | 'hidden' | 'partial' {
    const frames = new Map<NodeId, CertifiedClipRegion>();
    return (id, bounds) => {
        const node = doc.nodes.get(id); if (!node) throw new Error('Snap candidate disappeared');
        const box = [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height] as const;
        if (!box.every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) throw new RangeError('Snap candidate bounds are invalid');
        let partial = false;
        for (const frame of boardFrameAncestors(doc, node)) {
            let region = frames.get(frame.id);
            if (!region) {
                const pose = worldPose(doc, frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                region = preparePointClip({ outline: rectPath(frame.w, frame.h), localToSurface: [c, s, -s, c, pose.x, pose.y] }); frames.set(frame.id, region);
            }
            const relation = classifyCertifiedClipBox(box, region);
            if (relation === 'outside') return 'hidden';
            if (relation === 'overlap') partial = true;
        }
        return partial ? 'partial' : 'visible';
    };
}
