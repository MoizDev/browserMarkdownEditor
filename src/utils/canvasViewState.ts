import { flushRecord, readRecord, scopedKey } from './storage';

const POSITIONS_KEY = 'canvasViewPositions';

export type CanvasViewPos =
    | { kind: 'drawing'; pageId: string; x: number; y: number; z: number }
    | { kind: 'notebook'; page: number; offset: number; zoom?: number };

export interface NativeDrawingViewPos {
    kind: 'drawing'; v: 2; pageId: string; x: number; y: number; z: number;
}

const MIN_Z = 0.01;
const MAX_Z = 100;
const MAX_COORD = 1e7;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function readCanvasViewPos(path: string): CanvasViewPos | undefined {
    const pos = readRecord<unknown>(POSITIONS_KEY)[scopedKey(path)];
    if (!pos || typeof pos !== 'object') return undefined;
    const p = pos as Record<string, unknown>;
    if (p.kind === 'drawing') {
        // A native camera has the opposite sign and its sheet ids are not
        // library page ids. Never feed it back into the legacy editor.
        if (p.v !== undefined) return undefined;
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

export function readNativeDrawingViewPos(path: string, mapLegacyPage: (id: string) => string | undefined): NativeDrawingViewPos | undefined {
    const key = scopedKey(path);
    const records = readRecord<unknown>(POSITIONS_KEY);
    const raw = records[key];
    if (!raw || typeof raw !== 'object') return undefined;
    const p = raw as Record<string, unknown>;
    if (p.kind !== 'drawing' || typeof p.pageId !== 'string' || !finite(p.x) || !finite(p.y) || !finite(p.z)
        || Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD) return undefined;
    let result: NativeDrawingViewPos;
    if (p.v === 2) {
        if (!p.pageId) return undefined;
        result = { kind: 'drawing', v: 2, pageId: p.pageId, x: p.x, y: p.y, z: Math.min(MAX_Z, Math.max(MIN_Z, p.z)) };
    } else if (p.v === undefined && p.pageId.startsWith('page:')) {
        const pageId = mapLegacyPage(p.pageId);
        if (!pageId) return undefined;
        result = { kind: 'drawing', v: 2, pageId, x: -p.x, y: -p.y, z: Math.min(MAX_Z, Math.max(MIN_Z, p.z)) };
        records[key] = result;
        flushRecord(POSITIONS_KEY);
    } else return undefined;
    return result;
}

const round = (value: number, places: number) => {
    const f = 10 ** places;
    return Math.round(value * f) / f;
};

export function writeCanvasViewPos(path: string, pos: CanvasViewPos, flush = true): void {
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

export function writeNativeDrawingViewPos(path: string, pos: NativeDrawingViewPos, flush = true): void {
    readRecord<NativeDrawingViewPos>(POSITIONS_KEY)[scopedKey(path)] = {
        kind: 'drawing', v: 2, pageId: pos.pageId, x: round(pos.x, 2), y: round(pos.y, 2), z: round(pos.z, 4),
    };
    if (flush) flushRecord(POSITIONS_KEY);
}

export function flushCanvasViewPositions(): void {
    flushRecord(POSITIONS_KEY);
}

export function copyCanvasViewPos(from: string, to: string): void {
    const records = readRecord<unknown>(POSITIONS_KEY), pos = records[scopedKey(from)];
    if (!pos || typeof pos !== 'object') return;
    records[scopedKey(to)] = structuredClone(pos);
    flushRecord(POSITIONS_KEY);
}
