// Where a drawing or a notebook was left — the camera and page a `.tldraw` or
// `.notebook` reopens on. The canvases' sibling of pdfViewState.ts.
//
// Before this, both reopened wherever their FILE last said: a notebook on the
// snapshot's camera (written only when ink was saved), a drawing likewise — so
// panning alone was never remembered, and a notebook read to page 30 without
// writing reopened on whatever page it was last written on. Per-device view
// state, like the PDF and markdown records, so it lives in localStorage and
// never in the vault file (a pan must not dirty or rewrite a synced file).
//
// Imports nothing heavy: App reads it for tabs with no mounted pane (the agent's
// "where was this left" line), and the tldraw chunks write it.

import { flushRecord, readRecord, scopedKey } from './storage';

const POSITIONS_KEY = 'canvasViewPositions';

export type CanvasViewPos =
    /** A whiteboard: which tldraw page, and the camera on it (tldraw's own
     *  `{x, y, z}`, so it is handed straight back to `setCamera`). */
    | { kind: 'drawing'; pageId: string; x: number; y: number; z: number }
    /** `page` is 0-based, like pdfViewPositions; `offset` is how far into it the
     *  top edge sits (0..1); `zoom` is on top of fit-width (1 = fit width). */
    | { kind: 'notebook'; page: number; offset: number; zoom?: number };

/** tldraw's own zoom range is narrower; this only keeps a hand-edited value
 *  from reaching `setCamera` as 0, a negative or 1e300. */
const MIN_Z = 0.01;
const MAX_Z = 100;
/** Past this a camera is not somewhere anyone panned to — it is a typo. */
const MAX_COORD = 1e7;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Where `path` was left, if anywhere. Values are the user's to edit in
 * localStorage (and an older build may have written anything), so everything is
 * shape-checked and clamped here; callers still clamp `page` to the pages they
 * have and check `pageId` against the pages that exist.
 */
export function readCanvasViewPos(path: string): CanvasViewPos | undefined {
    const pos = readRecord<unknown>(POSITIONS_KEY)[scopedKey(path)];
    if (!pos || typeof pos !== 'object') return undefined;
    const p = pos as Record<string, unknown>;
    if (p.kind === 'drawing') {
        if (typeof p.pageId !== 'string' || !p.pageId.startsWith('page:')) return undefined;
        if (!finite(p.x) || !finite(p.y) || !finite(p.z)) return undefined;
        if (Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD) return undefined;
        return { kind: 'drawing', pageId: p.pageId, x: p.x, y: p.y, z: Math.min(MAX_Z, Math.max(MIN_Z, p.z)) };
    }
    if (p.kind === 'notebook') {
        if (!finite(p.page)) return undefined;
        return {
            kind: 'notebook',
            page: Math.max(0, Math.floor(p.page)),
            offset: finite(p.offset) ? Math.min(1, Math.max(0, p.offset)) : 0,
            zoom: finite(p.zoom) && p.zoom > 0 ? Math.min(MAX_Z, Math.max(MIN_Z, p.zoom)) : undefined,
        };
    }
    return undefined;
}

const round = (value: number, places: number) => {
    const f = 10 ** places;
    return Math.round(value * f) / f;
};

/**
 * Record where `path` is.
 *
 * `flush: false` updates only the in-memory record — a property write, cheap
 * enough for every frame of a pan; the panes debounce the flush (400ms) and
 * flush on unmount and on `pagehide`. Memory is what App reads back for a tab
 * with no pane, so memory must never be the half that lags.
 */
export function writeCanvasViewPos(path: string, pos: CanvasViewPos, flush = true): void {
    // The record is held parsed in memory — mutate and write, no re-parse.
    readRecord<CanvasViewPos>(POSITIONS_KEY)[scopedKey(path)] = pos.kind === 'drawing'
        ? { kind: 'drawing', pageId: pos.pageId, x: round(pos.x, 2), y: round(pos.y, 2), z: round(pos.z, 4) }
        : {
            kind: 'notebook',
            page: pos.page,
            offset: round(pos.offset, 3),
            ...(pos.zoom !== undefined ? { zoom: round(pos.zoom, 3) } : {}),
        };
    if (flush) flushRecord(POSITIONS_KEY);
}

/** Write whatever `writeCanvasViewPos(…, false)` has accumulated. */
export function flushCanvasViewPositions(): void {
    flushRecord(POSITIONS_KEY);
}
