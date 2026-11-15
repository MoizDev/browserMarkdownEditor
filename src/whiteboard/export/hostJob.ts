import { createNativeBoardImageExport, type NativeBoardImageExportOptions } from './boardExport';
import { exportFileName } from './scope';

export interface PinnedNativeImageJobOptions extends Omit<NativeBoardImageExportOptions, 'format'> {
    readonly signal: AbortSignal;
    readonly boardName: string;
    notice(message: string): void;
}
export interface PinnedNativeImageJob {
    png(signal: AbortSignal): Promise<Blob>;
    svg(signal: AbortSignal): Promise<Blob>;
    filename(extension: 'png' | 'svg'): string;
    release(): void;
}

/** Core can install the returned PNG/SVG promise in its ClipboardItem during the initiating event. */
export function preparePinnedNativeImageJob(options: PinnedNativeImageJobOptions): PinnedNativeImageJob {
    const { signal, boardName } = options;
    signal.throwIfAborted();
    const selected = options.route !== 'menu' && options.runtime.selection.getSnapshot().selected.length > 0;
    const stamp = new Date();
    const job = createNativeBoardImageExport({ ...options, format: 'png' });
    try { signal.throwIfAborted(); }
    catch (error) { job.release(); throw error; }
    let released = false;
    const release = () => { if (!released) { released = true; job.release(); } };
    const run = async (format: 'png' | 'svg', request: AbortSignal) => {
        const active = AbortSignal.any([signal, request]);
        const result = await job.runAs(format, active);
        active.throwIfAborted();
        if (result.reduced) options.notice('The copied image was scaled down to fit the clipboard.');
        return result.blob;
    };
    return {
        png: request => run('png', request),
        svg: request => run('svg', request),
        filename: extension => exportFileName(boardName, selected ? 'selection' : 'sheet', extension, stamp),
        release,
    };
}
