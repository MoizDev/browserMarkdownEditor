import { isLocked } from '../change/commands';
import { normalizedRotation, pageOrigin, poseInParent, worldPose, type ChangeGeometry, type WorldPose } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, isSheetParent, type BoardDoc } from '../model/doc';
import type { FigureNode, FrameNode, Node } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { PreparedBoardText } from '../render/textGeometry';
import type { Vec2 } from './path';
import { figureResizeDimensions, resizeFigureKind, resizeIntrinsicKind, type IntrinsicResizeNode } from './resizeKinds';
import { reflectedTargetAnchors } from './attachments';
import type { KindResizeFactors } from './resizeKinds.types';

export interface BoardLeafResizeOptions {
    readonly runtime: BoardRuntime;
    readonly doc?: BoardDoc;
    readonly factors: KindResizeFactors;
    /** The resize planner's mapped logical centre in world coordinates. */
    readonly centreWorld: Vec2;
    /** Reflections may change world orientation even when kind-local dimensions are unchanged. */
    readonly rotationWorld?: number;
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
    /** Missing or dimensionless media cannot certify an intrinsic aspect ratio. */
    readonly clipAspect?: 'intrinsic' | 'placeholder';
    release(): void;
}

type Leaf = FigureNode | FrameNode | IntrinsicResizeNode | Extract<Node, { kind: 'clip' | 'linkcard' | 'embed' }>;
function provisional(doc: BoardDoc, node: Readonly<Leaf>, world: WorldPose): NodeSetOp[] {
    let x: number, y: number, rotation: number;
    if (isSheetParent(doc, node.parent)) {
        const origin = pageOrigin(doc, node.page); x = world.x - origin.x; y = world.y - origin.y; rotation = world.rotation;
    } else {
        const parent = worldPose(doc, node.parent), dx = world.x - parent.x, dy = world.y - parent.y;
        const c = Math.cos(parent.rotation), s = Math.sin(parent.rotation);
        x = c * dx + s * dy; y = -s * dx + c * dy; rotation = world.rotation - parent.rotation;
    }
    return [{ t: 'set', id: node.id, key: 'x', value: x }, { t: 'set', id: node.id, key: 'y', value: y },
        { t: 'set', id: node.id, key: 'rotation', value: normalizedRotation(rotation) }];
}
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

/** Real leaf resize and placement; the returned geometry lease is caller-owned. */
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
    let kindOps: NodeSetOp[], clipAspect: BoardLeafResizeResult['clipAspect'];
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
    } else if (node.kind === 'frame' || node.kind === 'linkcard' || node.kind === 'embed' || node.kind === 'clip') {
        const extent = (value: number) => Math.min(1_000_000, Math.max(1, value));
        const x = Math.abs(factors.x), y = Math.abs(factors.y);
        if (node.kind === 'clip') {
            // Default, calibration cut by owner: clip resize uses its intrinsic aspect.
            if (x !== y) throw new Error('Clip resize requires a whole-selection uniform scale');
            const media = node.media ? doc.media.get(node.media) : undefined;
            const known = !!media && Number.isFinite(media.w) && Number.isFinite(media.h) && media.w > 0 && media.h > 0;
            clipAspect = known ? 'intrinsic' : 'placeholder';
            const ratio = known ? media!.w / media!.h : node.w / node.h;
            const minWidth = Math.max(1, ratio), maxWidth = Math.min(1_000_000, ratio * 1_000_000);
            if (!Number.isFinite(ratio) || ratio <= 0 || minWidth > maxWidth) throw new RangeError('Clip aspect cannot satisfy model dimensions');
            // Default, calibration cut by owner: a vertical side preserves its scaled height.
            const requestedWidth = factors.handle === 'side' && factors.handleX === 0 && factors.handleY
                ? node.h * y * ratio : node.w * x;
            const w = Math.max(minWidth, Math.min(maxWidth, requestedWidth)), h = extent(w / ratio);
            kindOps = [{ t: 'set', id: node.id, key: 'w', value: w }, { t: 'set', id: node.id, key: 'h', value: h }];
        } else {
            // Default, calibration cut by owner: card/embed reflow inside independently resized bounds.
            kindOps = [{ t: 'set', id: node.id, key: 'w', value: extent(node.w * x) },
                { t: 'set', id: node.id, key: 'h', value: extent(node.h * y) }];
        }
    } else {
        if (node.kind === 'sticky' && factors.scope === 'single') throw new Error('A single sticky has no resize handles');
        kindOps = asSets(resizeIntrinsicKind(node, factors));
    }
    const flipX = factors.x < 0 || (factors.x === 0 && factors.zeroSignX < 0);
    const flipY = factors.y < 0 || (factors.y === 0 && factors.zeroSignY < 0);
    kindOps.push(...reflectedTargetAnchors(doc, node.id, flipX, flipY));
    check();
    const candidate = await project(kindOps); check();
    const staged = await scope(candidate);
    let finalScope: BoardGeometryScope | undefined, success = false;
    try {
        check();
        const local = staged.localBounds(node.id), before = worldPose(candidate, node.id), angle = options.rotationWorld ?? before.rotation;
        if (!Number.isFinite(angle)) throw new RangeError('Invalid resized world rotation');
        const localX = (local[0] + local[2]) / 2, localY = (local[1] + local[3]) / 2;
        // Default, calibration cut by owner: an exact-zero release puts the model minimum on the crossed side.
        const crossedX = factors.x === 0 && factors.handleX ? factors.handleX * factors.zeroSignX * (local[2] - local[0]) / 2 : 0;
        const crossedY = factors.y === 0 && factors.handleY ? factors.handleY * factors.zeroSignY * (local[3] - local[1]) / 2 : 0;
        const c = Math.cos(angle), s = Math.sin(angle), world = {
            x: options.centreWorld.x + c * crossedX - s * crossedY - c * localX + s * localY,
            y: options.centreWorld.y + s * crossedX + c * crossedY - s * localX - c * localY, rotation: angle,
        };
        const placementOps: NodeSetOp[] = provisional(doc, node, world);
        if (node.kind === 'frame') {
            const original = worldPose(doc, node.id);
            if (world.x !== original.x || world.y !== original.y || angle !== original.rotation) {
                if (hasOpaqueDescendant(doc, node.id)) throw new Error('Cannot compensate opaque frame descendants');
                for (const child of childrenOf(doc, node.id)) {
                    const pose = worldPose(doc, child.id), dx = pose.x - world.x, dy = pose.y - world.y;
                    const x = c * dx + s * dy, y = -s * dx + c * dy, rotation = normalizedRotation(pose.rotation - angle);
                    if (x !== child.x) placementOps.push({ t: 'set', id: child.id, key: 'x', value: x });
                    if (y !== child.y) placementOps.push({ t: 'set', id: child.id, key: 'y', value: y });
                    if (rotation !== child.rotation) placementOps.push({ t: 'set', id: child.id, key: 'rotation', value: rotation });
                }
            }
        }
        const positioned = await project([...kindOps, ...placementOps]); check();
        const positionedScope = await scope(positioned);
        let finalDoc: BoardDoc;
        try {
            check(); const bounds = positionedScope.logicalBounds(node.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                worldBoundsCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) };
            const pose = poseInParent(doc, node as Node, node.parent, world, geometry);
            if (pose.page !== node.page) placementOps.push({ t: 'set', id: node.id, key: 'page', value: pose.page });
            placementOps.push({ t: 'set', id: node.id, key: 'x', value: pose.x }, { t: 'set', id: node.id, key: 'y', value: pose.y },
                { t: 'set', id: node.id, key: 'rotation', value: pose.rotation });
            finalDoc = await project([...kindOps, ...placementOps]); check();
        } finally { positionedScope.release(); }
        finalScope = await scope(finalDoc); check();
        const held = finalScope;
        const result: BoardLeafResizeResult = { kindOps: Object.freeze(kindOps.map(op => Object.freeze(op))),
            placementOps: Object.freeze(placementOps.map(op => Object.freeze(op))), doc: finalDoc, fontEpoch,
            ...(clipAspect ? { clipAspect } : {}),
            release() { if (!released) { released = true; try { held.release(); } finally { base.release(); } } } };
        success = true; return Object.freeze(result);
    } finally {
        try { if (!success) finalScope?.release(); } finally { staged.release(); }
    }
    } catch (error) { base.release(); throw error; }
}
