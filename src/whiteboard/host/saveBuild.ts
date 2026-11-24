import type { PinnedBoardBuild } from '../session/contentSource';
import type { BoardBuildPinning, BoardBuildPorts, PinnedMediaRestore, PinnedPdfAssembly } from './saveBuildTypes';

/** A restored media file received a different safe name; its set-file edit must be
 * checkpointed as a new revision before any document bytes can be committed. */
export class MediaLocationsChanged extends Error {
    constructor() { super('Media locations changed; checkpoint the board again'); this.name = 'MediaLocationsChanged'; }
}

export function createBoardBuildPinning(ports: BoardBuildPorts): BoardBuildPinning {
    let disposed = false;
    const pending = new Set<() => void>();
    return {
        pinBuild(base, revision, context): PinnedBoardBuild {
            if (disposed) throw new Error('Board build owner is disposed');
            if (base.revision !== revision) throw new Error('Board build revision mismatch');
            const media: PinnedMediaRestore = ports.pinMedia(revision);
            let pdf: PinnedPdfAssembly | undefined;
            try { pdf = ports.pinPdf?.(revision, context); }
            catch (error) { media.release(); throw error; }
            const lifetime = new AbortController();
            let released = false, result: Uint8Array | Blob | undefined, inFlight: Promise<Uint8Array | Blob> | undefined;
            let attempt: AbortController | undefined;
            const release = () => {
                if (released) return;
                released = true;
                // No asynchronous build may publish after its pinned resources retire.
                lifetime.abort();
                pending.delete(cancel);
                const retire = () => { try { media.release(); } finally { pdf?.release(); } };
                // A cancelled build can still be running in its worker: the abort reply does not prove the physical
                // work has stopped. Retire the pinned media and PDF only once the in-flight build has actually settled.
                if (inFlight) void inFlight.then(retire, retire);
                else retire();
            };
            const cancel = () => { lifetime.abort(); release(); };
            pending.add(cancel);
            return {
                revision,
                release,
                async build(signal) {
                    signal.throwIfAborted();
                    if (result) return result;
                    if (released || disposed) throw new DOMException('Board build expired', 'AbortError');
                    if (!inFlight) attempt = new AbortController();
                    const running = attempt!;
                    const abort = () => running.abort(signal.reason);
                    signal.addEventListener('abort', abort, { once: true });
                    if (signal.aborted) abort();
                    let current: Promise<Uint8Array | Blob> | undefined;
                    try {
                        if (!inFlight) {
                            const active = AbortSignal.any([lifetime.signal, running.signal]);
                            inFlight = (async () => {
                                active.throwIfAborted();
                                if (await media.restore(active) === 'changed') { release(); throw new MediaLocationsChanged(); }
                                active.throwIfAborted();
                                const board = await base.build(active);
                                active.throwIfAborted();
                                const bytes = pdf ? await pdf.assemble(board, active) : board;
                                active.throwIfAborted();
                                result = bytes;
                                release();
                                return bytes;
                            })();
                        }
                        current = inFlight;
                        return await current;
                    } finally {
                        signal.removeEventListener('abort', abort);
                        if (!result && inFlight === current) { inFlight = undefined; attempt = undefined; }
                    }
                },
            };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const cancel of [...pending]) cancel();
        },
    };
}
