import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import { acquireBoardGeometryScope } from './geometryScope';
import { notebookGrowthOp } from './pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent } from '../model/doc';
import { newNodeId, type NodeId } from '../model/ids';
import { createSticky, type StickyNode } from '../model/nodes';
import { keyBetween } from '../model/orderKey';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { EMPTY_RICH_TEXT } from '../text/richText';

export type StickyDirection = 'left' | 'right' | 'up' | 'down';
export interface StickyNeighbourOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly direction: StickyDirection;
    readonly zoom: number;
    /** Keyboard navigation reuses an eligible nearby note; pointer handles create. */
    readonly reuse: boolean;
    readonly current: () => boolean;
    readonly edit: (id: NodeId) => void | Promise<void>;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
function centre(doc: BoardRuntime['session']['doc'], node: Readonly<StickyNode>) {
    const pose = worldPose(doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
    const x = 100 * node.scale, y = (100 + node.growY / 2) * node.scale;
    return { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y, rotation: pose.rotation };
}

/** Adds a real blank note, or focuses an existing directional neighbour, in the active session. */
export async function addStickyNeighbour(options: StickyNeighbourOptions): Promise<NodeId> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || session.owner !== owner || session.doc !== doc || doc.rev !== revision
            || runtime.selection.getSnapshot() !== selection || session.isReadOnly) throw new DOMException('Sticky neighbour source changed', 'AbortError');
    };
    if (!Number.isFinite(options.zoom) || options.zoom <= 0) throw new RangeError('Invalid sticky neighbour zoom');
    check(); const source = doc.nodes.get(options.id);
    if (!source || source.kind !== 'sticky' || isLocked(doc, source)) throw new Error('Sticky neighbour requires an unlocked note');
    const scale = source.scale, c = Math.cos(source.rotation), s = Math.sin(source.rotation);
    const dx = options.direction === 'right' ? 210 * scale : options.direction === 'left' ? -210 * scale : 0;
    const dy = options.direction === 'down' ? (210 + source.growY) * scale : options.direction === 'up' ? -210 * scale : source.growY * scale / 2;
    const x = source.x + c * dx - s * dy, y = source.y + s * dx + c * dy;
    const siblings = doc.children.get(source.parent) ?? [], id = newNodeId(doc);
    const node = createSticky({ ...source, id, x, y, order: keyBetween(siblings.at(-1)?.order ?? null, null),
        text: EMPTY_RICH_TEXT, growY: 0, url: null, locked: false, ext: null });
    const candidate = createAddedBoardDoc(doc, [node]), candidateNode = candidate.nodes.get(id);
    if (!candidateNode || candidateNode.kind !== 'sticky') throw new Error('Sticky candidate is unavailable');
    const target = centre(candidate, candidateNode);
    if (options.reuse) {
        // Default, calibration cut by owner: ten CSS pixels is the neighbour reuse radius.
        const radius = 10 / options.zoom, scene = runtime.scene;
        if (!scene?.ready || scene.revision !== revision) throw new Error('Scene is not ready for neighbour lookup');
        const cursor = scene.spatialCursor({ sheetId: selection.sheet, purpose: 'selectable',
            request: { kind: 'box', box: [target.x - radius, target.y - radius, target.x + radius, target.y + radius] } });
        const found: { best?: { id: NodeId; distance: number; rank: number } } = {};
        try {
            for (;;) {
                check();
                const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 256 }, ref => {
                    const item = scene.resolveSpatial(ref); if (!item) throw new DOMException('Neighbour candidate changed', 'AbortError');
                    const other = doc.nodes.get(item.id);
                    if (!other || other.id === source.id || other.kind !== 'sticky' || isLocked(doc, other) || other.scale !== scale) return;
                    const position = centre(doc, other), turns = (position.rotation - target.rotation) / (2 * Math.PI);
                    if (Math.abs(turns - Math.round(turns)) > 8 * Number.EPSILON * Math.max(1, Math.abs(turns))) return;
                    const distance = Math.hypot(position.x - target.x, position.y - target.y);
                    const best = found.best;
                    if (distance <= radius && (!best || distance < best.distance || (distance === best.distance && item.rank > best.rank)))
                        found.best = { id: other.id, distance, rank: item.rank };
                });
                if (status === 'complete') break;
                if (status !== 'pending') throw new DOMException('Neighbour lookup became stale', 'AbortError');
                await cooperate();
            }
        } finally { cursor.cancel(); }
        check();
        if (found.best) { runtime.selection.replace([found.best.id]); await options.edit(found.best.id); return found.best.id; }
    }
    const scope = await acquireBoardGeometryScope(runtime, [id], { doc: candidate, signal, cooperate, current: () => {
        try { check(); return true; } catch { return false; }
    } });
    try {
        check(); const bounds = scope.logicalBounds(id), pose = worldPose(candidate, id);
        const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
            worldBoundsCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) };
        const placed = poseInParent(doc, node, node.parent, pose, geometry);
        const final = { ...node, x: placed.x, y: placed.y, rotation: placed.rotation, page: placed.page };
        const growth = isSheetParent(doc, final.parent) ? notebookGrowthOp(doc, bounds.y + bounds.height) : null;
        check(); const applied = session.apply({ origin: 'tool', label: 'Add sticky neighbour', ops: [
            ...(growth ? [growth] : []), { t: 'create', node: final },
        ] });
        applied.release(); runtime.selection.replace([id]);
    } finally { scope.release(); }
    if (options.current() && session.owner === owner && session.doc === doc) await options.edit(id);
    return id;
}
