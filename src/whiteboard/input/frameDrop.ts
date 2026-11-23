import { isLocked, rekeyParent, selectedRoots, stageReparent } from '../change/commands';
import { worldPose } from '../change/coordinates';
import type { NodeSetOp, Op, OpSink } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { inverse } from '../geom/affine';
import type { BoardTranslationPreview } from '../geom/runtimeTranslation';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { FrameNode, Node } from '../model/nodes';
import { keysBetween, needsRekey } from '../model/orderKey';
import { bindingContainer } from '../geom/connectorParent';

export interface FrameDropOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly preview: BoardTranslationPreview;
    readonly signal: AbortSignal;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}
export interface FrameDropPlan {
    readonly ops: readonly NodeSetOp[];
    release(): void;
}
interface Candidate { readonly frame: Readonly<FrameNode>; readonly rank: number; readonly depth: number }

/** Frame membership is planned from the staged translation, then committed with
 * that translation in the same transaction. Geometry comes from the pinned scope. */
export async function prepareFrameDrop(options: FrameDropOptions): Promise<FrameDropPlan | null> {
    const { runtime, signal } = options, session = runtime.session, doc = session.doc, candidate = options.preview.doc;
    const owner = session.owner, revision = doc.rev, selection = runtime.selection.getSnapshot(), font = runtime.render.text.fonts.epoch;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const current = () => !signal.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && runtime.selection.getSnapshot() === selection && runtime.render.text.fonts.epoch === font;
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Frame drop became stale', 'AbortError'); };
    check();
    const roots = selectedRoots(doc, options.ids).filter(node => {
        const parent = doc.nodes.get(node.parent as NodeId);
        return isSheetParent(doc, node.parent) || parent?.kind === 'frame';
    });
    if (!roots.length) return null;
    const scope = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { doc: candidate, signal, current, cooperate });
    let keep = false;
    try {
        check();
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, work = 0;
        for (const root of roots) {
            const b = scope.logicalBounds(root.id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
            x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
            if (++work % 128 === 0) { await cooperate(); check(); }
        }
        const scene = runtime.scene ?? await runtime.ready;
        while (!scene.ready) { check(); scene.step(64, performance.now() + 3); await cooperate(); }
        check(); if (scene.revision !== revision) throw new DOMException('Frame drop scene changed', 'AbortError');
        const frames = new Map<NodeId, Candidate>();
        const add = (id: NodeId, rank: number) => {
            const frame = candidate.nodes.get(id);
            if (!frame || frame.kind !== 'frame' || isLocked(candidate, frame)) return;
            let parent: ParentId = frame.parent, depth = 0;
            for (; depth < 64; depth++) {
                const next = candidate.nodes.get(parent as NodeId);
                if (!next || next.kind !== 'frame') break;
                parent = next.parent;
            }
            const old = frames.get(id);
            if (!old || rank > old.rank) frames.set(id, { frame, rank, depth });
        };
        const cursor = scene.spatialCursor({ sheetId: selection.sheet, purpose: 'selectable',
            request: { kind: 'box', box: [x0, y0, x1, y1] } });
        try {
            for (;;) {
                check(); const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 256 }, ref => {
                    const resolved = scene.resolveSpatial(ref);
                    if (!resolved) throw new DOMException('Frame drop candidate expired', 'AbortError');
                    add(resolved.id, resolved.rank);
                });
                if (status === 'complete') break;
                if (status !== 'pending') throw new DOMException('Frame drop query expired', 'AbortError');
                await cooperate();
            }
        } finally { cursor.cancel(); }
        // A frame being exited may no longer intersect the translated root's bounds.
        for (const root of roots) {
            let parent = candidate.nodes.get(root.parent as NodeId);
            for (let depth = 0; parent?.kind === 'frame' && depth < 64; depth++) {
                add(parent.id, -1); parent = candidate.nodes.get(parent.parent as NodeId);
            }
        }
        const baseParent = (node: Readonly<Node>): ParentId => {
            let parent = node.parent;
            for (let depth = 0; depth < 64; depth++) {
                const value = candidate.nodes.get(parent as NodeId);
                if (!value || value.kind !== 'frame') break;
                parent = value.parent;
            }
            return parent;
        };
        const selected = new Set(roots.map(root => root.id)), destinations: { id: NodeId; parent: ParentId }[] = [];
        const insideSelection = (frame: Readonly<FrameNode>): boolean => {
            let value: Readonly<Node> | undefined = frame;
            for (let depth = 0; value && depth < 64; depth++) {
                if (selected.has(value.id)) return true;
                value = candidate.nodes.get(value.parent as NodeId);
            }
            return false;
        };
        for (const root of roots) {
            check(); const moved = candidate.nodes.get(root.id);
            if (!moved || moved.kind === 'opaque') throw new Error('Translated node is unavailable');
            const boundary = baseParent(moved); let best: Candidate | undefined;
            for (const item of frames.values()) {
                check();
                if (insideSelection(item.frame) || baseParent(item.frame) !== boundary) continue;
                const pose = worldPose(candidate, item.frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                const back = inverse([c, s, -s, c, pose.x, pose.y], 1e12);
                if (!back) throw new RangeError('Frame transform is not invertible');
                const b = await scope.boundsInSpace(moved.id, back); check();
                if (b[0] >= 0 && b[1] >= 0 && b[2] <= item.frame.w && b[3] <= item.frame.h
                    && (!best || item.depth > best.depth || (item.depth === best.depth && item.rank > best.rank))) best = item;
                if (++work % 128 === 0) { await cooperate(); check(); }
            }
            // Default: preserve the enclosing non-frame scope; among overlapping frames use the deepest, then topmost.
            const parent = best?.frame.id ?? boundary;
            if (parent !== moved.parent) destinations.push({ id: moved.id, parent });
        }
        // An arrow bound to a moved shape follows it: it joins the container its two ends now share (catalogue a.5), in this same
        // transaction. Arrows bound to a moved shape's children are left where they are; only the moved roots' attachments count.
        const landed = new Map<NodeId, ParentId>(destinations.map(item => [item.id, item.parent]));
        const parentAfter = (id: NodeId): ParentId | undefined => landed.get(id) ?? candidate.nodes.get(id)?.parent;
        const followers = new Set<NodeId>();
        for (const root of roots) for (const id of candidate.attachedTo.get(root.id) ?? []) if (!selected.has(id)) followers.add(id);
        for (const id of followers) {
            check(); const arrow = candidate.nodes.get(id);
            if (!arrow || arrow.kind !== 'connector' || isLocked(candidate, arrow)) continue;
            const container = bindingContainer(candidate, arrow.start.attach, arrow.end.attach, parentAfter);
            if (container === null || container === arrow.parent) continue;
            const holder = isSheetParent(candidate, container) ? undefined : candidate.nodes.get(container as NodeId);
            if (holder && isLocked(candidate, holder)) continue;
            destinations.push({ id: arrow.id, parent: container });
        }
        if (!destinations.length) return null;
        const ops: NodeSetOp[] = [], grouped = new Map<ParentId, NodeId[]>();
        const sink: OpSink = { push(op: Op) { if (op.t !== 'set') throw new Error('Frame drop emitted a non-set operation'); ops.push(op); } };
        for (const item of destinations) {
            const ids = grouped.get(item.parent) ?? []; ids.push(item.id); grouped.set(item.parent, ids);
        }
        for (const [parent, ids] of grouped) {
            check(); const tail = candidate.children.get(parent)?.at(-1);
            let last = tail?.order ?? null, keys = keysBetween(last, null, ids.length);
            if (keys.some(needsRekey)) {
                const start = ops.length; rekeyParent(candidate, sink, parent);
                const changed = tail && ops.slice(start).find(op => op.id === tail.id && op.key === 'order');
                last = changed && typeof changed.value === 'string' ? changed.value : tail?.order ?? null;
                keys = keysBetween(last, null, ids.length);
                if (keys.some(needsRekey)) throw new Error('Frame drop cannot allocate a safe order key');
            }
            for (let index = 0; index < ids.length; index++) {
                check(); const node = candidate.nodes.get(ids[index]);
                if (!node || node.kind === 'opaque') throw new Error('Frame drop node disappeared');
                stageReparent(candidate, sink, node, parent, scope.geometry, keys[index]);
                if (++work % 128 === 0) { await cooperate(); check(); }
            }
        }
        check(); keep = true;
        return { ops: Object.freeze(ops), release: () => scope.release() };
    } finally { if (!keep) scope.release(); }
}
