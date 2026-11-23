import { isLocked } from '../change/commands';
import { sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import { boardPageStack } from '../model/pages';
import { pageAt } from '../../platform/render/pageStack';
import type { BoardPayload, ClipboardBounds } from './snapshot';
import type { ClipboardIntent, ClipboardPoint, ClipboardTarget } from './types';

// Provenance: clipboard placement §6, page-stack and frame locking contracts;
// independent pure placement planner, no third-party source.
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
    /** A duplicate repeating the offset its predecessor was moved by (catalogue S§7.4, K§2); absent, the copy steps right. */
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
    let parent: ParentId = target.sheet;
    if (target.selectedFrame !== null) {
        const frame = doc.nodes.get(target.selectedFrame as NodeId);
        if (!frame || frame.kind !== 'frame' || sheetOf(doc, frame.id) !== target.sheet) throw new Error('Clipboard target frame is stale');
        if (!options.containsFrame && !isLocked(doc, frame)) parent = frame.id;
    }
    const bounds = source.bounds, viewport = target.viewport;
    const sourceCentre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    const viewportCentre = { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
    const inside = bounds.x >= viewport.x && bounds.y >= viewport.y
        && bounds.x + bounds.w <= viewport.x + viewport.w && bounds.y + bounds.h <= viewport.y + viewport.h;
    const same = source.from !== null && source.from.board === receivingBoardId && source.from.sheet === target.sheet;
    const inverted = intent === 'paste-inverted' || intent === 'paste-plain-inverted';
    const cursor = target.pasteAtCursor !== inverted;
    let centre: ClipboardPoint, preserve = false;
    if (intent === 'drop') {
        if (!target.pointer) throw new RangeError('Drop placement requires its captured world point');
        centre = target.pointer;
    } else if (intent === 'duplicate') {
        // Duplicate steps right by the selection's width plus a 10-unit gap, in world units (spec F-ARR-005: 190 then 280).
        // A repeat steps by the offset the previous copy now sits at, so a copy moved by hand is followed at the same distance.
        centre = options.duplicateOffset ? { x: sourceCentre.x + options.duplicateOffset.x, y: sourceCentre.y + options.duplicateOffset.y }
            : { x: sourceCentre.x + bounds.w + 10, y: sourceCentre.y };
    } else if (cursor) centre = target.pointer ?? viewportCentre;
    // Plain paste lands in the view, never over its source: in place is the inverted (⌥) paste's own result.
    else if (inverted && same && inside) { centre = sourceCentre; preserve = true; }
    else centre = viewportCentre;
    // In-place is exact even when existing content straddles a physical page gap.
    if (!preserve) centre = clampPoint(doc, centre);
    const delta = { x: centre.x - sourceCentre.x, y: centre.y - sourceCentre.y };
    const origin = { x: bounds.x + delta.x, y: bounds.y + delta.y };
    if (![centre.x, centre.y, delta.x, delta.y, origin.x, origin.y].every(Number.isFinite)) throw new RangeError('Clipboard placement overflows');
    return Object.freeze({ worldOrigin: Object.freeze(origin), worldCentre: Object.freeze({ ...centre }), delta: Object.freeze(delta), parent,
        preserveSourcePosition: preserve });
}
