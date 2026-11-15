import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { Rect } from '../../platform/types';
import type { BoardRuntime } from '../host/runtime';
import type { MediaEntry } from '../model/media';
import { measureBoardPaintBounds } from '../render/worldBounds';
import { createBoardExportSnapshot } from './boardSnapshot';
import type { BoardPrintSource } from './print';
import { pinNativeNotebookPrint } from './notebookPrint';
import { pinBoardPrintSource } from './printSnapshot';
import { snapshotPaintSource } from './snapshot';

export interface NativeBoardPrintOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly onError: (error: unknown) => void;
}

/** The print source of the open board, pinned to one revision. A notebook prints its pages; a
 * whiteboard prints the ink bounds of its current sheet. PDF ink boards print their backdrop too,
 * which this source does not yet compose, so they are refused rather than printed without it. */
export async function pinNativeBoardPrint(options: NativeBoardPrintOptions): Promise<BoardPrintSource> {
    const { runtime } = options, doc = runtime.session.doc, scene = runtime.scene;
    if (doc.kind === 'notebook') return pinNativeNotebookPrint(options);
    if (doc.kind !== 'whiteboard') throw new Error('PDF ink boards cannot be printed from the board yet');
    if (!scene || !scene.ready || scene.revision !== doc.rev) throw new Error('Print scene is not ready');
    const sheet = runtime.selection.getSnapshot().sheet;
    if (!doc.sheets.has(sheet)) throw new Error('Print sheet is unavailable');
    const pin = createBoardExportSnapshot({ runtime, request: { sheetId: sheet, theme: 'light' },
        readMedia: options.readMedia, onError: options.onError });
    const snapshot = pin(), lifetime = new AbortController();
    let world: Readonly<Rect>;
    try {
        const source = await snapshotPaintSource(snapshot, lifetime.signal);
        const measured = await measureBoardPaintBounds(source, { memory: options.memory, signal: lifetime.signal, toleranceWorld: 0.01 });
        lifetime.signal.throwIfAborted();
        const box = measured.bounds, error = measured.errorWorld;
        if (!box || !box.every(Number.isFinite) || !Number.isFinite(error) || error < 0) throw new Error('Nothing to print');
        world = Object.freeze({ x: box[0] - error, y: box[1] - error, width: box[2] - box[0] + 2 * error, height: box[3] - box[1] + 2 * error });
        if (!(world.width > 0 && world.height > 0)) throw new Error('Nothing to print');
    } catch (error) {
        snapshot.release();
        throw error;
    }
    return pinBoardPrintSource(() => snapshot, world);
}
