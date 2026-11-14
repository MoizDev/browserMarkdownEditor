import type { Rgba } from '../../platform/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardRuntime } from '../host/runtime';
import type { MediaEntry } from '../model/media';
import { createNativeBoardImageExport, type NativeBoardImageExportResult } from './boardExport';
import type { DisplayPdfWriter } from './capturePdf';
import { pinNativeNotebookPrint } from './notebookPrint';
import type { PagedPrintStreamWriter } from './pagedPrintSnapshot';
import { printBoard } from './print';
import { pinNativeWhiteboardPrint } from './whiteboardPrint';

export interface NativeBoardExportCommandsOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly whiteboardWriter: DisplayPdfWriter;
    readonly notebookWriter: DisplayPdfWriter | PagedPrintStreamWriter;
    readonly onError: (error: unknown) => void;
    /** Core captures the current theme and transparent setting when the gesture starts. */
    appearance(): { readonly theme: 'light' | 'dark'; readonly background: Rgba; readonly transparent: boolean };
    /** Core owns downloads, user activation, clipboard MIME and notices. */
    download(result: NativeBoardImageExportResult, format: 'png' | 'svg', signal: AbortSignal): Promise<void>;
    copyPng(result: Promise<NativeBoardImageExportResult>, signal: AbortSignal): Promise<void>;
    copySvg(result: Promise<NativeBoardImageExportResult>, signal: AbortSignal): Promise<void>;
    notice(message: string): void;
}

/** One export epoch per pane; actual rendering stays on the pinned scene and shared workers. */
export function createNativeBoardExportCommands(options: NativeBoardExportCommandsOptions) {
    let disposed = false, active: AbortController | null = null;
    const cancel = () => { const old = active; active = null; old?.abort(new DOMException('Export superseded', 'AbortError')); };
    const begin = (signal: AbortSignal) => {
        if (disposed) throw new DOMException('Export owner ended', 'AbortError');
        signal.throwIfAborted(); cancel();
        const controller = new AbortController(); active = controller;
        return { controller, signal: AbortSignal.any([signal, controller.signal]) };
    };
    const end = (controller: AbortController) => { if (active === controller) active = null; };
    return {
        image(route: 'menu' | 'context' | 'copy', format: 'png' | 'svg', signal: AbortSignal): Promise<void> {
            let operation: ReturnType<typeof begin>;
            try { operation = begin(signal); } catch (error) { return Promise.reject(error); }
            try {
                const look = options.appearance();
                const job = createNativeBoardImageExport({ runtime: options.runtime, route, format, theme: look.theme,
                    background: look.background, transparent: look.transparent, memory: options.memory,
                    readMedia: options.readMedia, onError: options.onError });
                const result = job.run(operation.signal);
                // The callback is invoked synchronously so Core can create its promised ClipboardItem under activation.
                let delivery: Promise<void>;
                try {
                    delivery = route === 'copy'
                        ? format === 'png' ? options.copyPng(result, operation.signal) : options.copySvg(result, operation.signal)
                        : result.then(value => options.download(value, format, operation.signal));
                } catch (error) {
                    operation.controller.abort(error); void result.catch(() => {}); job.release(); throw error;
                }
                return Promise.all([result, delivery]).then(([value]) => {
                    operation.signal.throwIfAborted();
                    if (value.reduced) options.notice('The copied image was scaled down to fit the clipboard.');
                }).finally(() => { job.release(); end(operation.controller); });
            } catch (error) { end(operation.controller); return Promise.reject(error); }
        },
        print(signal: AbortSignal): Promise<void> {
            let operation: ReturnType<typeof begin>;
            try { operation = begin(signal); } catch (error) { return Promise.reject(error); }
            try {
                const host = options.runtime.session.doc.host.kind;
                const pin = host === 'whiteboard'
                    ? () => pinNativeWhiteboardPrint({ runtime: options.runtime, memory: options.memory, writer: options.whiteboardWriter,
                        readMedia: options.readMedia, onError: options.onError })
                    : host === 'notebook'
                        ? () => pinNativeNotebookPrint({ runtime: options.runtime, memory: options.memory, writer: options.notebookWriter,
                            readMedia: options.readMedia, onError: options.onError })
                        : null;
                if (!pin) throw new Error('PDF-ink print requires the Core-composed PDF source');
                return printBoard({ pin, signal: operation.signal, notice: message => options.notice(message) }).finally(() => end(operation.controller));
            } catch (error) { end(operation.controller); return Promise.reject(error); }
        },
        cancel,
        dispose() { if (!disposed) { disposed = true; cancel(); } },
    };
}
