import { cpuGovernor, createWorkerClient } from '../../platform/workers';
import type { WorkerClient } from '../../platform/workers';
import type { InspectedMedia } from './ingest';
import type { SafeFullFrameLease } from './paintImages';
import { svgParseBudget } from './svgBudget';
import { boardWorker } from '../workers/client';
import { boardEnvelope, closeWorkerResult, matchingIdentity, validBoardIdentity } from '../workers/protocol';
import type { BoardJobIdentity } from '../workers/protocol';

// Provenance: media admission, governed worker and isolated SVG frame contracts;
// independent full-frame ownership wiring, no third-party source.
export interface FullFrameDecoderOptions {
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
    reserveCpu(bytes: number): { release(): void } | null;
    /** Network-denied SVG image profile; must support full intrinsic dimensions,
     * settle on abort only after its frame is disposed, and never use a main-origin parser. */
    svg?(blob: Blob, info: InspectedMedia, identity: BoardJobIdentity, signal: AbortSignal): Promise<ImageBitmap>;
    /** Explicit host-owned video poster decoder; cancellation releases intermediates. */
    video(blob: Blob, info: InspectedMedia, identity: BoardJobIdentity, signal: AbortSignal): Promise<ImageBitmap>;
}
export type BoardFullFrameDecoder = ((blob: Blob, info: InspectedMedia, identity: BoardJobIdentity,
    signal: AbortSignal) => Promise<SafeFullFrameLease>) & { dispose(): void };
let serial = 0;

export function createBoardFullFrameDecoder(options: FullFrameDecoderOptions): BoardFullFrameDecoder {
    if (!validBoardIdentity(options.identity)) throw new TypeError('Invalid full-frame decoder identity');
    const owner = Object.freeze({ ...options.identity }), workers = new Set<WorkerClient>(), aborters = new Set<AbortController>();
    let disposed = false;
    const run = async (blob: Blob, info: InspectedMedia, identity: BoardJobIdentity, signal: AbortSignal): Promise<SafeFullFrameLease> => {
        signal.throwIfAborted();
        if (disposed || !matchingIdentity(owner, identity) || !options.isCurrent(owner)) throw new DOMException('Stale full-frame request', 'AbortError');
        if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File) || blob.size > 10 * 1024 * 1024
            || info.mime === 'image/svg+xml' && blob.size > 5 * 1024 * 1024 || !/^sha256:[0-9a-f]{64}$/.test(info.id) || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
            || info.width <= 0 || info.height <= 0 || info.width > (2 ** 26) / info.height) throw new TypeError('Invalid full-frame source');
        const bytes = info.width * info.height * 4;
        const output = options.reserveCpu(bytes);
        if (!output) throw new Error('Insufficient memory for full-frame image');
        const parsing = info.mime === 'image/svg+xml' ? options.reserveCpu(svgParseBudget(blob.size)) : null;
        if (info.mime === 'image/svg+xml' && !parsing) { output.release(); throw new Error('Insufficient memory for SVG parsing'); }
        const controller = new AbortController(); aborters.add(controller);
        const combined = AbortSignal.any([signal, controller.signal]);
        let worker: WorkerClient | undefined, bitmap: ImageBitmap | undefined, outputOwned = true;
        let scratch: { release(): void } | null = null, canvas: { release(): void } | null = null;
        const check = () => {
            combined.throwIfAborted();
            if (disposed || !options.isCurrent(owner)) throw new DOMException('Stale full-frame request', 'AbortError');
        };
        try {
            let scratchBytes = info.mime === 'image/avif' ? 4 * (2 ** 26) : bytes;
            if (info.mime === 'image/svg+xml') {
                const decoder = boardWorker('decode'); let preflight: boolean;
                try { preflight = await decoder.request<boolean>('svgPreflight', { blob }, owner,
                    { priority: 0, deadlineMs: 5000, signal: combined }, options.isCurrent); }
                catch (error) { if (combined.aborted) await decoder.recycle('SVG preflight cancelled').catch(() => undefined); throw error; }
                check(); if (preflight !== true) throw new Error('Invalid SVG preflight response');
                const [{ createSvgAdmissionProfile }, { svgFrameFactory }] = await Promise.all([import('./svgProfile'), import('./svgFrameHost')]);
                check();
                const header = await createSvgAdmissionProfile(svgFrameFactory, owner, options.isCurrent).header(blob, combined);
                check();
                if (header.width !== info.width || header.height !== info.height) throw new Error('Full-frame SVG header mismatch');
                scratchBytes = header.rgbaBytes;
            }
            scratch = options.reserveCpu(scratchBytes);
            if (!scratch) throw new Error('Insufficient memory for full-frame decoding');
            if (info.mime === 'image/svg+xml') {
                canvas = options.reserveCpu(bytes);
                if (!canvas) throw new Error('Insufficient memory for SVG canvas');
                const svg = options.svg ?? (await import('./svgProfile')).createIsolatedFullFrameSvgDecoder(options.isCurrent);
                check(); bitmap = await svg(blob, info, owner, combined);
            }
            else if (info.mime.startsWith('video/')) bitmap = await options.video(blob, info, owner, combined);
            else {
                worker = createWorkerClient({ name: `whiteboard-full-frame-${++serial}`, protocol: 1, permits: cpuGovernor,
                    spawn: () => new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' }),
                    disposeResult: (_op, result) => closeWorkerResult(result) });
                workers.add(worker);
                // A native decode is not interruptible inside a worker turn. Termination
                // precedes releasing the scratch reservation on abort or error.
                const stop = () => worker?.dispose();
                combined.addEventListener('abort', stop, { once: true });
                try {
                    const reply: unknown = await worker.request('fullFrame', { identity: owner,
                        payload: { blob, id: info.id, mime: info.mime, width: info.width, height: info.height, animated: info.animated } },
                    { priority: 0, cpu: 'governed', deadlineMs: 30_000, terminateOnDeadline: true, signal: combined });
                    if (!boardEnvelope(reply) || !matchingIdentity(owner, reply.identity) || !reply.payload || typeof reply.payload !== 'object'
                        || !('bitmap' in reply.payload) || !(reply.payload.bitmap instanceof ImageBitmap)) {
                        closeWorkerResult(reply); throw new TypeError('Invalid full-frame worker reply');
                    }
                    bitmap = reply.payload.bitmap;
                } finally { combined.removeEventListener('abort', stop); worker.dispose(); workers.delete(worker); worker = undefined; }
            }
            check();
            if (!(bitmap instanceof ImageBitmap) || bitmap.width !== info.width || bitmap.height !== info.height) throw new Error('Full-frame bitmap dimensions mismatch');
            const owned = bitmap; bitmap = undefined; outputOwned = false;
            let released = false;
            return { bitmap: owned, cpuBytes: bytes, release() { if (!released) { released = true; try { owned.close(); } finally { output.release(); } } } };
        } catch (error) { bitmap?.close(); throw error; }
        finally {
            worker?.dispose(); if (worker) workers.delete(worker);
            aborters.delete(controller); parsing?.release(); canvas?.release(); scratch?.release(); if (outputOwned) output.release();
        }
    };
    return Object.assign(run, { dispose() {
        if (disposed) return;
        disposed = true;
        for (const controller of aborters) controller.abort();
        for (const worker of workers) worker.dispose();
        workers.clear();
    } });
}
