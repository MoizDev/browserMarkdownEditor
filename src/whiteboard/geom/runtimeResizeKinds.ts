import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, type BoardDoc } from '../model/doc';
import type { FigureNode, FrameNode, Node } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { PreparedBoardText } from '../render/textGeometry';
import type { Vec2 } from './path';
import { figureResizeDimensions, resizeFigureKind } from './resizeKinds';
import type { KindResizeFactors } from './resizeKinds.types';

export interface BoardLeafResizeOptions {
    readonly runtime: BoardRuntime;
    readonly doc?: BoardDoc;
    readonly factors: KindResizeFactors;
    /** The resize planner's mapped logical centre in world coordinates. */
    readonly centreWorld: Vec2;
    /** Fences the source candidate, session and gesture through result release. */
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface BoardLeafResizeResult {
    readonly kindOps: readonly NodeSetOp[];
    readonly placementOps: readonly NodeSetOp[];
    readonly doc: BoardDoc;
    readonly fontEpoch: number;
    release(): void;
}

type Leaf = FigureNode | FrameNode;
function asSets(ops: ReturnType<typeof resizeFigureKind>): NodeSetOp[] {
    return ops.map(op => { if (op.t !== 'set') throw new TypeError('Resize kind produced a non-set operation'); return op; });
}
function loadedText(runtime: BoardRuntime, value: PreparedBoardText): boolean {
    const text = runtime.render.text;
    return text.fonts.isLoaded({ family: value.request.style.font, bold: false, italic: false })
        && value.paint.lines.every(line => line.fragments.every(fragment => !!text.faces.faces[fragment.face]?.loaded));
}
async function loadText(runtime: BoardRuntime, node: FigureNode, signal: AbortSignal, check: () => void): Promise<void> {
    const text = runtime.render.text, first = text.prepareNow(node, { revision: `resize-load:${node.id}` });
    if (!first) return;
    const keys = new Map<string, { family: typeof first.request.style.font; bold: boolean; italic: boolean }>();
    const base = { family: first.request.style.font, bold: false, italic: false }; keys.set(JSON.stringify(base), base);
    for (const line of first.paint.lines) for (const fragment of line.fragments) {
        const face = text.faces.faces[fragment.face]; if (!face) throw new Error('Figure text face is unavailable');
        keys.set(JSON.stringify(face.key), face.key);
    }
    for (const key of keys.values()) { if (!await text.fonts.load(key)) throw new Error('Required figure font could not be loaded'); check(); }
}

/** Real figure growth and frame boundary resize; the returned geometry lease is caller-owned. */
export async function prepareBoardLeafResize(node: Readonly<Leaf>, options: BoardLeafResizeOptions): Promise<BoardLeafResizeResult> {
    const { runtime, factors } = options, session = runtime.session, live = session.doc, doc = options.doc ?? live;
    const owner = session.owner, revision = doc.rev, liveRevision = live.rev, host = doc.host;
    const signal = options.signal ?? new AbortController().signal;
    let fontEpoch: number | undefined, released = false;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === live
        && live.rev === liveRevision && doc.rev === revision && doc.host === host && !session.isReadOnly
        && (fontEpoch === undefined || runtime.render.text.fonts.epoch === fontEpoch);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Leaf resize became stale', 'AbortError'); };
    check();
    if (doc.nodes.get(node.id) !== node || isLocked(doc, node) || ![factors.x, factors.y, options.centreWorld.x, options.centreWorld.y].every(Number.isFinite))
        throw new RangeError('Invalid leaf resize source');
    const project = (ops: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, ops, { signal, current, cooperate: options.cooperate });
    const scope = (candidate: BoardDoc) => acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal, current, cooperate: options.cooperate });
    const base = await scope(doc);
    try {
    check(); fontEpoch = runtime.render.text.fonts.epoch;
    let kindOps: NodeSetOp[];
    if (node.kind === 'figure') {
        const { width, height } = figureResizeDimensions(node, factors);
        const initial = asSets(resizeFigureKind(node, factors, { h: height, growY: 0 }));
        const candidate = await project(initial); check();
        const provisional = candidate.nodes.get(node.id);
        if (!provisional || provisional.kind !== 'figure') throw new Error('Projected figure disappeared');
        await loadText(runtime, provisional, signal, check); check();
        const first = await runtime.render.text.prepare(provisional, { revision: `resize-first:${node.id}:${revision}` }, signal); check();
        if (first && !loadedText(runtime, first)) throw new Error('Figure text faces are unavailable');
        const required = first ? runtime.render.text.layout.measure(first.request).requiredHeight : 0;
        const growY = first ? Math.max(0, required + node.width - height) : 0;
        if (!Number.isFinite(growY)) throw new RangeError('Resized figure growth is invalid');
        kindOps = asSets(resizeFigureKind(node, factors, { h: height, growY }));
        const grown = await project(kindOps); check();
        const grownNode = grown.nodes.get(node.id);
        if (!grownNode || grownNode.kind !== 'figure' || grownNode.w !== width) throw new Error('Projected figure growth is unavailable');
        // Re-layout with final growth and the same loaded faces, not the provisional paint.
        const second = await runtime.render.text.prepare(grownNode, { revision: `resize-final:${node.id}:${revision}` }, signal); check();
        if (second && !loadedText(runtime, second)) throw new Error('Figure text faces are unavailable');
        if (second && Math.max(0, runtime.render.text.layout.measure(second.request).requiredHeight + node.width - height) !== growY)
            throw new Error('Figure layout changed during resize');
    } else {
        const extent = (value: number) => Math.min(1_000_000, Math.max(1, value));
        kindOps = [{ t: 'set', id: node.id, key: 'w', value: extent(node.w * Math.abs(factors.x)) },
            { t: 'set', id: node.id, key: 'h', value: extent(node.h * Math.abs(factors.y)) }];
    }
    check();
    const candidate = await project(kindOps); check();
    const staged = await scope(candidate);
    let finalScope: BoardGeometryScope | undefined, success = false;
    try {
        check();
        const local = staged.localBounds(node.id), before = worldPose(candidate, node.id), angle = before.rotation;
        const localX = (local[0] + local[2]) / 2, localY = (local[1] + local[3]) / 2;
        const c = Math.cos(angle), s = Math.sin(angle), world = {
            x: options.centreWorld.x - c * localX + s * localY,
            y: options.centreWorld.y - s * localX - c * localY, rotation: angle,
        };
        const bounds = staged.logicalBounds(node.id), center = {
            x: bounds.x + bounds.width / 2 + world.x - before.x,
            y: bounds.y + bounds.height / 2 + world.y - before.y,
        };
        const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
            worldBoundsCenter: () => center };
        const pose = poseInParent(doc, node as Node, node.parent, world, geometry), placementOps: NodeSetOp[] = [];
        if (pose.page !== node.page) placementOps.push({ t: 'set', id: node.id, key: 'page', value: pose.page });
        if (pose.x !== node.x) placementOps.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
        if (pose.y !== node.y) placementOps.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
        if (node.kind === 'frame') {
            const original = worldPose(doc, node.id), dx = world.x - original.x, dy = world.y - original.y;
            if (dx !== 0 || dy !== 0) {
                if (hasOpaqueDescendant(doc, node.id)) throw new Error('Cannot compensate opaque frame descendants');
                const shiftX = c * dx + s * dy, shiftY = -s * dx + c * dy;
                for (const child of childrenOf(doc, node.id)) {
                    if (shiftX !== 0) placementOps.push({ t: 'set', id: child.id, key: 'x', value: child.x - shiftX });
                    if (shiftY !== 0) placementOps.push({ t: 'set', id: child.id, key: 'y', value: child.y - shiftY });
                }
            }
        }
        const finalDoc = await project([...kindOps, ...placementOps]); check();
        finalScope = await scope(finalDoc); check();
        const held = finalScope;
        const result: BoardLeafResizeResult = { kindOps: Object.freeze(kindOps.map(op => Object.freeze(op))),
            placementOps: Object.freeze(placementOps.map(op => Object.freeze(op))), doc: finalDoc, fontEpoch,
            release() { if (!released) { released = true; try { held.release(); } finally { base.release(); } } } };
        success = true; return Object.freeze(result);
    } finally {
        try { if (!success) finalScope?.release(); } finally { staged.release(); }
    }
    } catch (error) { base.release(); throw error; }
}
