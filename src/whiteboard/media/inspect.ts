import { createWorkerClient } from '../../platform/workers';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { MediaId, MediaMime } from '../model/media';
import type { InspectedMedia } from './ingest';
import { checkMediaBytes, checkMediaDimensions } from '../security/limits';
import { sniffMedia } from './sniff';

// SVG must be parsed and decoded in a network-denied opaque realm. This narrow
// port deliberately cannot fall back to a detached parser in the vault origin.
export interface SvgAdmissionProfile {
    header(blob: Blob, signal: AbortSignal): Promise<{ readonly width: number; readonly height: number }>;
    probe(blob: Blob, signal: AbortSignal): Promise<void>;
}
interface WorkerInspection {
    readonly id: MediaId;
    readonly mime: MediaMime;
    readonly width: number;
    readonly height: number;
    readonly animated: boolean;
}
const worker = createWorkerClient({
    name: 'whiteboard-media-decode', protocol: 1,
    spawn: () => new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' }),
});

function validSize(width: number, height: number): boolean {
    return checkMediaDimensions(width, height).ok;
}

async function videoProbe(blob: Blob, header: WorkerInspection, signal: AbortSignal): Promise<number> {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    try {
        return await new Promise<number>((resolve, reject) => {
            const clean = () => {
                video.removeEventListener('loadeddata', loaded);
                video.removeEventListener('error', failed);
                signal.removeEventListener('abort', aborted);
            };
            const failed = () => { clean(); reject(new Error('This video could not be read')); };
            const aborted = () => { clean(); reject(signal.reason); };
            const loaded = () => {
                const width = video.videoWidth, height = video.videoHeight;
                const matches = (width === header.width && height === header.height) || (width === header.height && height === header.width);
                if (!matches || !validSize(width, height) || !Number.isFinite(video.duration) || video.duration < 0) { failed(); return; }
                clean();
                resolve(video.duration);
            };
            video.addEventListener('loadeddata', loaded);
            video.addEventListener('error', failed);
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) aborted();
            else { video.src = url; video.load(); }
        });
    } finally {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
}

export async function inspectMedia(blob: Blob, options: { signal?: AbortSignal; svg?: SvgAdmissionProfile; memory: MemoryAllocator }): Promise<InspectedMedia> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    signal.throwIfAborted();
    if (!checkMediaBytes(blob.size, 'raster').ok) throw new RangeError('Media files must be at most 10 MiB');
    const prefix = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    signal.throwIfAborted();
    if (sniffMedia(prefix) === 'image/svg+xml') {
        if (!checkMediaBytes(blob.size, 'svg').ok) throw new RangeError('SVG files must be at most 5 MiB');
        if (!options.svg) throw new Error('SVG decoding is unavailable');
        await worker.request<boolean>('svgPreflight', { blob }, { priority: 1, deadlineMs: 5000, signal });
        signal.throwIfAborted();
        const size = await options.svg.header(blob, signal);
        signal.throwIfAborted();
        if (!validSize(size.width, size.height)) throw new RangeError('Invalid SVG dimensions');
        const id = await worker.request<MediaId>('hash', { blob }, { priority: 1, deadlineMs: 10000, signal });
        signal.throwIfAborted();
        const lease = options.memory.reserve(4 * size.width * size.height);
        if (!lease) throw new Error('Not enough memory to decode this picture');
        try {
            const typed = blob.slice(0, blob.size, 'image/svg+xml');
            try {
                await worker.request<boolean>('probe', { blob: typed, width: size.width, height: size.height, animated: false, mime: 'image/svg+xml' }, { priority: 1, deadlineMs: 10000, signal });
            } catch {
                await worker.recycle('SVG worker probe failed', { lazy: true }).catch(() => undefined);
                signal.throwIfAborted();
                await options.svg.probe(typed, signal);
            }
        } finally { options.memory.release(lease); }
        signal.throwIfAborted();
        return { id, mime: 'image/svg+xml', width: size.width, height: size.height, animated: false, duration: null };
    }
    const result = await worker.request<WorkerInspection>('inspect', { blob }, { priority: 1, deadlineMs: 10000, signal });
    signal.throwIfAborted();
    if (!/^sha256:[0-9a-f]{64}$/.test(result.id) || !validSize(result.width, result.height)) throw new Error('Invalid media worker reply');
    const lease = options.memory.reserve(4 * result.width * result.height);
    if (!lease) throw new Error('Not enough memory to decode this media');
    try {
        const duration = result.mime.startsWith('video/') ? await videoProbe(blob, result, signal) : null;
        if (duration === null) {
            try {
                await worker.request<boolean>('probe', { blob, width: result.width, height: result.height, animated: result.animated, mime: result.mime }, { priority: 1, deadlineMs: 10000, signal });
            } catch (error) {
                // A cancelled native decoder may still be running after its request settles.
                await worker.recycle('cancelled image probe', { lazy: true }).catch(() => undefined);
                throw error;
            }
        }
        signal.throwIfAborted();
        return { ...result, duration };
    } finally { options.memory.release(lease); }
}
