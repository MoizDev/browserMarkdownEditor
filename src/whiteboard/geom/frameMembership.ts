import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import type { BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { FrameNode } from '../model/nodes';
import { keysBetween, needsRekey, type OrderKey } from '../model/orderKey';
import { pointInTransformedFrame } from './frameContainment';
import type { Vec2 } from './path';
import { projectGeometryReparents, type GeometryReparent } from './reparentProjection';
import { findFrameMembershipTargets, type FrameMembershipCentre } from './frameMembershipCandidates';
import { yieldToHost } from '../../platform/yieldToHost';

export interface FrameMembershipOptions {
    readonly runtime: BoardRuntime;
    readonly doc: BoardDoc;
    readonly roots: readonly NodeId[];
    readonly geometry: BoardGeometryScope;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface FrameMembershipProjection { readonly doc: BoardDoc; readonly ops: readonly NodeSetOp[] }

function containsFrame(doc: BoardDoc, frame: Readonly<FrameNode>, point: Vec2): boolean {
    const pose = worldPose(doc, frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    return pointInTransformedFrame(point, { x: 0, y: 0, width: frame.w, height: frame.h }, [c, s, -s, c, pose.x, pose.y]);
}
function insideFocus(doc: BoardDoc, parent: ParentId, focus: ParentId): boolean {
    for (let depth = 0; depth <= 64; depth++) {
        if (parent === focus) return true;
        if (isSheetParent(doc, parent)) return false;
        const node = doc.nodes.get(parent as NodeId); if (!node) throw new Error('Frame focus ancestry is unavailable');
        parent = node.parent;
    }
    throw new Error('Frame focus ancestry is too deep');
}
export async function projectFrameMembership(options: FrameMembershipOptions): Promise<FrameMembershipProjection> {
    const { runtime, doc, geometry, signal } = options, live = runtime.session.doc, revision = live.rev, owner = runtime.session.owner;
    const selection = runtime.selection.getSnapshot(), selected = new Set(options.roots);
    const cooperate = options.cooperate ?? yieldToHost;
    let scene = runtime.scene;
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || runtime.session.owner !== owner || runtime.session.doc !== live || live.rev !== revision
            || runtime.selection.getSnapshot() !== selection || (scene && runtime.scene !== scene))
            throw new DOMException('Frame membership source changed', 'AbortError');
    };
    check(); if (geometry.doc !== doc) throw new Error('Frame membership geometry is not the staged document');
    if (!scene) {
        scene = await new Promise<Awaited<BoardRuntime['ready']>>((resolve, reject) => {
            const cleanup = () => signal.removeEventListener('abort', abort);
            const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Frame membership cancelled', 'AbortError')); };
            signal.addEventListener('abort', abort, { once: true });
            runtime.ready.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
            if (signal.aborted) abort();
        });
        check();
    }
    while (!scene.ready) { scene.step(64, performance.now() + 3); await cooperate(); check(); }
    if (scene.revision !== revision) throw new DOMException('Frame membership Scene changed', 'AbortError');
    const changes: GeometryReparent[] = [], ops: NodeSetOp[] = [], lastOrder = new Map<ParentId, OrderKey | null>();
    let work = 0;
    const tick = async () => { if (++work % 256 === 0) { await cooperate(); check(); } };
    const centres: FrameMembershipCentre[] = [];
    for (const id of options.roots) {
        check(); const node = doc.nodes.get(id);
        if (!node || node.kind === 'opaque' || isLocked(doc, node) || sheetOf(doc, id) !== selection.sheet) throw new Error('Frame membership root is unavailable');
        const b = geometry.logicalBounds(id), point = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        if (![point.x, point.y].every(Number.isFinite)) throw new RangeError('Frame membership centre overflows');
        let parent: ParentId = node.parent;
        for (let depth = 0; depth < 64 && !isSheetParent(doc, parent); depth++) {
            const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Frame membership parent disappeared');
            if (ancestor.kind !== 'frame' || containsFrame(doc, ancestor, point)) break;
            parent = ancestor.parent;
        }
        if (!insideFocus(doc, parent, selection.focus)) throw new Error('Cannot move a selection outside its focused container');
        centres.push({ id, parent, point }); await tick();
    }
    const targets = await findFrameMembershipTargets({ runtime, scene, doc, sheet: selection.sheet, centres, selected, signal,
        current: () => { try { check(); return true; } catch { return false; } }, cooperate });
    check();
    for (const { id, parent, point } of centres) {
        const node = doc.nodes.get(id); if (!node) throw new DOMException('Frame membership root disappeared', 'AbortError');
        const destination: ParentId = targets.get(id)?.id ?? parent;
        if (destination === node.parent) { await tick(); continue; }
        let last = lastOrder.get(destination);
        if (last === undefined) {
            const siblings = doc.children.get(destination) ?? []; last = siblings.length ? siblings[siblings.length - 1].order : null;
        }
        const key = keysBetween(last, null, 1)[0];
        if (!key || needsRekey(key)) throw new Error('Frame membership cannot allocate an order without rekeying');
        lastOrder.set(destination, key);
        const world = worldPose(doc, id), changeGeometry: ChangeGeometry = {
            resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
            worldBoundsCenter: () => point,
        };
        const pose = poseInParent(doc, node, destination, world, changeGeometry);
        changes.push({ id, parent: destination, page: pose.page, x: pose.x, y: pose.y, rotation: pose.rotation, order: key });
        ops.push({ t: 'set', id, key: 'parent', value: destination }, { t: 'set', id, key: 'page', value: pose.page },
            { t: 'set', id, key: 'x', value: pose.x }, { t: 'set', id, key: 'y', value: pose.y },
            { t: 'set', id, key: 'rotation', value: pose.rotation }, { t: 'set', id, key: 'order', value: key });
        await tick();
    }
    check();
    if (!changes.length) return { doc, ops: [] };
    const projected = await projectGeometryReparents(doc, changes, { signal, current: options.current, cooperate });
    check(); return { doc: projected, ops: Object.freeze(ops.map(op => Object.freeze(op))) };
}
