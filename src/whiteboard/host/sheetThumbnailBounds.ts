import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import type { Rect } from '../../platform/types';
import type { SheetId } from '../model/ids';
import { measureBoardPaintBounds } from '../render/worldBounds';
import { inspectPdfVisualDoc } from './pdfVisualPreflight';
import type { BoardRuntime } from './runtime';

let serial = 0;

/** The capture begins synchronously while the measured Scene pin is still held. */
export async function pinNativeSheetThumbnailBounds(options: {
    runtime: BoardRuntime;
    sheet: SheetId;
    revision: number;
    fontEpoch: number;
    current(): boolean;
    capture(rect: Rect, signal: AbortSignal): Promise<Blob>;
    signal: AbortSignal;
}): Promise<{ readonly bounds: Rect; readonly blob: Blob }> {
    const { runtime, sheet, revision, fontEpoch, signal } = options;
    const scene = runtime.scene, doc = runtime.session.doc;
    const check = () => {
        signal.throwIfAborted();
        if (!options.current() || runtime.session.doc !== doc || doc.rev !== revision ||
            runtime.selection.getSnapshot().sheet !== sheet || runtime.render.text.fonts.epoch !== fontEpoch ||
            runtime.scene !== scene || scene?.revision !== revision) throw new DOMException('Board thumbnail source changed', 'AbortError');
    };
    check();
    if (!scene?.ready || doc.kind !== 'whiteboard') throw new Error('Drawing scene is not ready for a minimap');
    const pin = scene.pin();
    const now = performance.now();
    let live = 0;
    let cache: ReturnType<ReturnType<typeof getPlatformRuntime>['governor']['register']>;
    try {
        cache = getPlatformRuntime().governor.register({ id: `sheet-thumbnail:${pin.token.documentId}:${++serial}`,
            owner: pin.token, pool: 'cpu', kind: 'capture', class: 'critical', hiddenAt: null,
            lastVisibleAt: now, lastUsedAt: now, memory: () => ({ live, retiring: 0 }), evict: () => {} });
    } catch (error) { pin.release(); throw error; }
    const memory = {
        reserve(bytes: number) { const lease = cache.reserve(bytes); if (lease) live += lease.bytes; return lease; },
        release(lease: Parameters<typeof cache.release>[0]) { cache.release(lease); live -= lease.bytes; },
    };
    try {
        const frozen = await pin.readDocument(signal); check();
        if (frozen.rev !== revision || !frozen.sheets.has(sheet)) throw new Error('Drawing sheet is unavailable');
        const visual = await inspectPdfVisualDoc(frozen, { signal }); check();
        if (visual.status !== 'known') throw new Error('The minimap cannot represent unsupported drawing content.');
        const paint = await pin.paintSource({ sheetId: sheet, theme: 'light' }, signal); check();
        const measured = await measureBoardPaintBounds(paint, { memory, signal }); check();
        const value = measured.bounds;
        if (!value || !value.every(Number.isFinite) || value[2] <= value[0] || value[3] <= value[1]) {
            throw new Error('There is no measurable drawing content for a minimap.');
        }
        const bounds = { x: value[0], y: value[1], width: value[2] - value[0], height: value[3] - value[1] };
        check();
        const pending = options.capture(bounds, signal);
        const blob = await pending;
        check();
        return { bounds, blob };
    } finally { try { pin.release(); } finally { cache.close(); } }
}
