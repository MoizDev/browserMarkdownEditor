import { printBoard } from '../../whiteboard/export/print';
import { exportFileName } from '../../whiteboard/export/scope';
import { pinNativeBoardPrint } from '../../whiteboard/export/nativePrint';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { MediaEntry } from '../../whiteboard/model/media';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { downloadBlob } from '../../utils/downloadBlob';

export interface NativePrintOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly current: () => boolean;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly boardName: () => string;
    readonly notice: (message: string) => void;
    readonly onError: (error: unknown) => void;
}

/** Print and PDF export share one single-flight authority: each pins the open board once, then hands
 * that pin to the canonical path. Disposing the shell aborts whatever is still in flight. */
export function createNativePrint(options: NativePrintOptions) {
    const lifetime = new AbortController();
    let active: AbortController | null = null;
    const start = (work: (signal: AbortSignal) => Promise<void>): boolean => {
        if (lifetime.signal.aborted || !options.current() || active) return false;
        const controller = new AbortController();
        active = controller;
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        void work(signal).catch(error => {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            options.onError(error);
        }).finally(() => { if (active === controller) active = null; });
        return true;
    };
    const pin = (signal: AbortSignal) => { signal.throwIfAborted(); return pinNativeBoardPrint({ runtime: options.runtime,
        memory: options.memory, readMedia: options.readMedia, onError: options.onError }); };
    /** The sheet name joins the file name only when the board has more than one sheet, as file export does. */
    const sheetName = () => {
        const doc = options.runtime.session.doc;
        return doc.sheetOrder.length > 1 ? doc.sheets.get(options.runtime.selection.getSnapshot().sheet)?.name ?? null : null;
    };
    return {
        /** Returns false when the board is not current or an export or print is already running. */
        run(): boolean {
            return start(async signal => {
                const source = await pin(signal);
                try { await printBoard({ pin: () => source, signal, notice: options.notice }); }
                finally { source.release(); }
            });
        },
        /** Whole-sheet PDF of the open board, saved under the board's name. */
        exportPdf(): boolean {
            return start(async signal => {
                const source = await pin(signal);
                try {
                    const blob = await source.pdf(signal);
                    signal.throwIfAborted();
                    downloadBlob(blob, exportFileName(options.boardName(), sheetName(), 'sheet', 'pdf', new Date()));
                } finally { source.release(); }
            });
        },
        dispose() { lifetime.abort(); },
    };
}
