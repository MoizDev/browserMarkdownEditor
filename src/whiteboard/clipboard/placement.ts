import { isLocked } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { boardSnapGrid, nearestBoardGridCoordinate } from '../geom/gridSnap';
import { sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import { boardPageStack } from '../model/pages';
import { pageAt } from '../../platform/render/pageStack';
import type { BoardPayload, ClipboardBounds } from './snapshot';
import type { ClipboardIntent, ClipboardPoint, ClipboardTarget } from './types';

export interface BoardClipboardPlacement {
    readonly worldOrigin: ClipboardPoint;
    readonly worldCentre: ClipboardPoint;
    readonly delta: ClipboardPoint;
    readonly parent: ParentId;
    readonly preserveSourcePosition: boolean;
}
export interface BoardClipboardPlacementOptions {
    readonly receivingBoardId: string;
    readonly target: Readonly<ClipboardTarget>;
    readonly source: { readonly from: BoardPayload['from'] | null; readonly bounds: ClipboardBounds };
    readonly containsFrame: boolean;
    readonly doc: BoardDoc;
    readonly cameraZoom: number;
    readonly intent: ClipboardIntent;
    readonly duplicateOffset?: { readonly x: number; readonly y: number } | null;
}
function boundsValid(value: ClipboardBounds): boolean {
    return !!value && [value.x, value.y, value.w, value.h, value.x + value.w, value.y + value.h].every(Number.isFinite)
        && value.w >= 0 && value.h >= 0;
}
function identity(value: unknown): value is string {
    if (typeof value !== 'string' || !value.length || value.length > 128) return false;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32 || value.charCodeAt(i) === 127) return false;
    return true;
}
function clampPoint(doc: BoardDoc, point: ClipboardPoint): ClipboardPoint {
    const stack = boardPageStack(doc.host);
    if (!stack) return point;
    const index = pageAt(stack, point.y), rect = stack.rects[index];
    if (!rect || ![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite)
        || rect.width <= 0 || rect.height <= 0) throw new RangeError('Paged board has no valid placement page');
    return { x: Math.max(rect.x, Math.min(rect.x + rect.width, point.x)),
        y: Math.max(rect.y, Math.min(rect.y + rect.height, point.y)) };
}
function frameUnder(doc: BoardDoc, sheet: SheetId, point: ClipboardPoint): ParentId | null {
    let best: ParentId | null = null, bestDepth = -1;
    for (const id of doc.bySheet.get(sheet) ?? []) {
        const node = doc.nodes.get(id);
        if (!node || node.kind !== 'frame' || isLocked(doc, node)) continue;
        const pose = worldPose(doc, node.id), dx = point.x - pose.x, dy = point.y - pose.y;
        const c = Math.cos(-pose.rotation), s = Math.sin(-pose.rotation);
        const lx = c * dx - s * dy, ly = s * dx + c * dy;
        if (lx < 0 || ly < 0 || lx > node.w || ly > node.h) continue;
        let depth = 0;
        for (let parent: ParentId | undefined = node.parent; depth < 64 && parent !== undefined; depth++) parent = doc.nodes.get(parent as NodeId)?.parent;
        if (depth > bestDepth) { best = node.id; bestDepth = depth; }
    }
    return best;
}

export function planBoardClipboardPlacement(options: BoardClipboardPlacementOptions): BoardClipboardPlacement {
    const { receivingBoardId, target, source, doc, cameraZoom, intent } = options;
    if (!identity(receivingBoardId) || !target || !source || (source.from !== null && (!source.from || !identity(source.from.board) || !identity(source.from.sheet)
        || !['whiteboard', 'notebook', 'pdf-ink'].includes(source.from.kind))) || !identity(target.session) || !identity(target.sheet)
        || !Number.isSafeInteger(target.vaultEpoch) || target.vaultEpoch < 0 || !Number.isSafeInteger(target.generation) || target.generation < 0
        || typeof target.pasteAtCursor !== 'boolean' || typeof options.containsFrame !== 'boolean'
        || !boundsValid(source.bounds) || !boundsValid(target.viewport) || target.viewport.w <= 0 || target.viewport.h <= 0
        || !Number.isFinite(cameraZoom) || cameraZoom <= 0
        || !['paste', 'paste-inverted', 'paste-plain', 'paste-plain-inverted', 'drop', 'duplicate'].includes(intent)) {
        throw new RangeError('Invalid clipboard placement input');
    }
    if (source.from === null && intent === 'duplicate') throw new Error('External content cannot be duplicated');
    if (doc.kind !== doc.host.kind || !doc.sheets.has(target.sheet)) throw new Error('Clipboard target sheet is stale');
    if (target.pointer !== null && (!target.pointer || !Number.isFinite(target.pointer.x) || !Number.isFinite(target.pointer.y))) {
        throw new RangeError('Invalid clipboard pointer');
    }
    const inverted = intent === 'paste-inverted' || intent === 'paste-plain-inverted';
    const cursor = target.pasteAtCursor !== inverted;
    const cursorPaste = cursor && target.pointer !== null && intent !== 'drop' && intent !== 'duplicate';
    let parent: ParentId = target.sheet;
    if (cursorPaste) {
        if (!options.containsFrame) parent = frameUnder(doc, target.sheet, target.pointer!) ?? target.sheet;
    } else if (target.selectedFrame !== null) {
        const frame = doc.nodes.get(target.selectedFrame as NodeId);
        if (!frame || frame.kind !== 'frame' || sheetOf(doc, frame.id) !== target.sheet) throw new Error('Clipboard target frame is stale');
        if (!options.containsFrame && !isLocked(doc, frame)) parent = frame.id;
    }
    const bounds = source.bounds, viewport = target.viewport;
    const sourceCentre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    const viewportCentre = { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
    const overlaps = bounds.x < viewport.x + viewport.w && bounds.x + bounds.w > viewport.x
        && bounds.y < viewport.y + viewport.h && bounds.y + bounds.h > viewport.y;
    const same = source.from !== null && source.from.board === receivingBoardId && source.from.sheet === target.sheet;
    let centre: ClipboardPoint, preserve = false;
    if (intent === 'drop') {
        if (!target.pointer) throw new RangeError('Drop placement requires its captured world point');
        centre = target.pointer;
    } else if (intent === 'duplicate') {
        centre = options.duplicateOffset ? { x: sourceCentre.x + options.duplicateOffset.x, y: sourceCentre.y + options.duplicateOffset.y }
            : { x: sourceCentre.x + bounds.w + 10, y: sourceCentre.y };
    } else if (cursor) centre = target.pointer ?? viewportCentre;
    else if (same && overlaps) { centre = sourceCentre; preserve = true; }
    else centre = viewportCentre;
    if (!preserve) centre = clampPoint(doc, centre);
    let delta = { x: centre.x - sourceCentre.x, y: centre.y - sourceCentre.y };
    let origin = { x: bounds.x + delta.x, y: bounds.y + delta.y };
    const lattice = preserve || intent === 'duplicate' ? null : boardSnapGrid(doc);
    if (lattice && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
        origin = { x: nearestBoardGridCoordinate(origin.x, lattice.origin.x, lattice.step.x).coordinate,
            y: nearestBoardGridCoordinate(origin.y, lattice.origin.y, lattice.step.y).coordinate };
        delta = { x: origin.x - bounds.x, y: origin.y - bounds.y };
        centre = { x: sourceCentre.x + delta.x, y: sourceCentre.y + delta.y };
    }
    if (![centre.x, centre.y, delta.x, delta.y, origin.x, origin.y].every(Number.isFinite)) throw new RangeError('Clipboard placement overflows');
    return Object.freeze({ worldOrigin: Object.freeze(origin), worldCentre: Object.freeze({ ...centre }), delta: Object.freeze(delta), parent,
        preserveSourcePosition: preserve });
}
