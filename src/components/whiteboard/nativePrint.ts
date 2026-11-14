import { printBoard } from '../../whiteboard/export/print';
import { pinNativeBoardPrint } from '../../whiteboard/export/nativePrint';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { MediaEntry } from '../../whiteboard/model/media';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';

export interface NativePrintOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly current: () => boolean;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly notice: (message: string) => void;
    readonly onError: (error: unknown) => void;
}

/** One print at a time. Each print pins the open board first, then hands that pin to the
 * canonical print path; disposing the shell aborts a print still in flight. */
export function createNativePrint(options: NativePrintOptions) {
    const lifetime = new AbortController();
    let active: AbortController | null = null;
    return {
        /** Returns false when the board is not current or a print is already running. */
        run(): boolean {
            if (lifetime.signal.aborted || !options.current() || active) return false;
            const controller = new AbortController();
            active = controller;
            const signal = AbortSignal.any([lifetime.signal, controller.signal]);
            void (async () => {
                const source = await pinNativeBoardPrint({ runtime: options.runtime, memory: options.memory,
                    readMedia: options.readMedia, onError: options.onError });
                try {
                    await printBoard({ pin: () => source, signal, notice: options.notice });
                } finally { source.release(); }
            })().catch(error => {
                if (error instanceof DOMException && error.name === 'AbortError') return;
                options.onError(error);
            }).finally(() => { if (active === controller) active = null; });
            return true;
        },
        dispose() { lifetime.abort(); },
    };
}
