import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import { acquireBoardGeometryScope } from './geometryScope';
import { notebookGrowthOp } from './pagesAndSheets';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, sheetOf } from '../model/doc';
import { newNodeId, type NodeId } from '../model/ids';
import { createSticky } from '../model/nodes';
import { keyBetween, needsRekey } from '../model/orderKey';
import { createAddedBoardDoc } from '../model/overlayDoc';
import { EMPTY_RICH_TEXT } from '../text/richText';
import { findStickyNeighbour, stickyWorldCentre } from '../geom/stickyNeighbours';

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
    if (!Number.isFinite(options.zoom) || options.zoom <= 0 || !['left', 'right', 'up', 'down'].includes(options.direction))
        throw new RangeError('Invalid sticky neighbour request');
    check(); const source = doc.nodes.get(options.id);
    if (!source || source.kind !== 'sticky' || isLocked(doc, source) || sheetOf(doc, source.id) !== selection.sheet)
        throw new Error('Sticky neighbour requires an unlocked note on the active sheet');
    const scale = source.scale, c = Math.cos(source.rotation), s = Math.sin(source.rotation);
    const dx = options.direction === 'right' ? 210 * scale : options.direction === 'left' ? -210 * scale : 0;
    const dy = options.direction === 'down' ? (210 + source.growY) * scale : options.direction === 'up' ? -210 * scale : source.growY * scale / 2;
    const x = source.x + c * dx - s * dy, y = source.y + s * dx + c * dy;
    if (![scale, c, s, dx, dy, x, y].every(Number.isFinite) || scale <= 0) throw new RangeError('Sticky neighbour position overflows');
    const siblings = doc.children.get(source.parent) ?? [], id = newNodeId(doc), order = keyBetween(siblings.at(-1)?.order ?? null, null);
    if (!order) throw new Error('Sticky neighbour cannot allocate an order');
    const node = createSticky({ ...source, id, x, y, order,
        text: EMPTY_RICH_TEXT, growY: 0, url: null, locked: false, ext: null });
    const candidate = createAddedBoardDoc(doc, [node]), candidateNode = candidate.nodes.get(id);
    if (!candidateNode || candidateNode.kind !== 'sticky') throw new Error('Sticky candidate is unavailable');
    const target = stickyWorldCentre(candidate, candidateNode);
    if (options.reuse) {
        // Default, calibration cut by owner: ten CSS pixels is the neighbour reuse radius.
        const radius = 10 / options.zoom;
        const found = await findStickyNeighbour({ runtime, doc, source, target, sheet: selection.sheet, focus: selection.focus, radius, signal, cooperate,
            current: () => { try { check(); return true; } catch { return false; } } });
        check();
        if (found) { runtime.selection.replace([found]); await options.edit(found); return found; }
    }
    if (needsRekey(order)) throw new Error('Sticky neighbour cannot allocate an order without rekeying');
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
