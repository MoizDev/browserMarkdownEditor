import { boardWorker } from '../workers/client';
import type { BoardJobIdentity } from '../workers/protocol';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { MEDIA_MIMES, type MediaId, type MediaMime } from '../model/media';
import type { InspectedMedia } from './ingest';
import { checkMediaBytes, checkMediaDimensions } from '../security/limits';
import { sniffMedia } from './sniff';
import { createSvgAdmissionProfile } from './svgProfile';
import { svgFrameFactory } from './svgFrameHost';
import { svgParseBudget } from './svgBudget';
import { videoFrameInProfile } from './videoFrameHost';

// SVG must be parsed and decoded in a network-denied opaque realm. This narrow
// port deliberately cannot fall back to a detached parser in the vault origin.
export interface SvgAdmissionProfile {
    header(blob: Blob, signal: AbortSignal): Promise<{ readonly width: number; readonly height: number; readonly rgbaBytes: number }>;
    probe(blob: Blob, width: number, height: number, signal: AbortSignal): Promise<void>;
}
interface WorkerInspection {
    readonly id: MediaId;
    readonly mime: MediaMime;
    readonly width: number;
    readonly height: number;
    readonly animated: boolean;
    readonly decodePixels: number;
}
const worker = boardWorker('decode');

function validSize(width: number, height: number): boolean {
    return checkMediaDimensions(width, height).ok;
}

export async function inspectMedia(blob: Blob, options: { signal?: AbortSignal; svg?: SvgAdmissionProfile; memory: MemoryAllocator;
    identity: BoardJobIdentity; isCurrent: (identity: BoardJobIdentity) => boolean }): Promise<InspectedMedia> {
    // File objects carry path-like metadata and are refused by the worker host;
    // a Blob slice preserves the bytes without sending that metadata across.
    blob = blob.slice(0, blob.size, blob.type);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    const call = <T>(op: string, payload: unknown, deadlineMs: number): Promise<T> =>
        worker.request<T>(op, payload, options.identity, { priority: 1, deadlineMs, signal }, options.isCurrent);
    signal.throwIfAborted();
    if (!checkMediaBytes(blob.size, 'raster').ok) throw new RangeError('Media files must be at most 10 MiB');
    const prefix = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    signal.throwIfAborted();
    if (sniffMedia(prefix) === 'image/svg+xml') {
        if (!checkMediaBytes(blob.size, 'svg').ok) throw new RangeError('SVG files must be at most 5 MiB');
        const svg = options.svg ?? createSvgAdmissionProfile(svgFrameFactory, options.identity, options.isCurrent);
        const parsing = options.memory.reserve(svgParseBudget(blob.size));
        if (!parsing) throw new Error('Not enough memory to inspect this SVG');
        let size: Awaited<ReturnType<SvgAdmissionProfile['header']>>;
        try {
            try {
                if (await call<boolean>('svgPreflight', { blob }, 5000) !== true) throw new Error('Invalid SVG preflight response');
            } catch (error) {
                if (signal.aborted) await worker.recycle('SVG preflight cancelled').catch(() => undefined);
                throw error;
            }
            signal.throwIfAborted();
            size = await svg.header(blob, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
            signal.throwIfAborted();
        } finally { options.memory.release(parsing); }
        if (!validSize(size.width, size.height) || !Number.isSafeInteger(size.rgbaBytes)
            || size.rgbaBytes < 4 * size.width * size.height || size.rgbaBytes > 4 * (2 ** 26)) throw new RangeError('Invalid SVG dimensions');
        const id = await call<MediaId>('hash', { blob }, 10000);
        signal.throwIfAborted();
        if (typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error('Invalid media worker reply');
        const lease = options.memory.reserve(size.rgbaBytes);
        if (!lease) throw new Error('Not enough memory to decode this picture');
        try {
            const parsingProbe = options.memory.reserve(svgParseBudget(blob.size));
            if (!parsingProbe) throw new Error('Not enough memory to probe this SVG');
            try {
                const typed = blob.slice(0, blob.size, 'image/svg+xml');
                try {
                    await call<boolean>('probe', { blob: typed, width: size.width, height: size.height, animated: false, mime: 'image/svg+xml' }, 10000);
                } catch (error) {
                    if (signal.aborted) { await worker.recycle('SVG worker probe cancelled').catch(() => undefined); throw error; }
                    await svg.probe(typed, size.width, size.height, signal);
                }
            } finally { options.memory.release(parsingProbe); }
        } finally { options.memory.release(lease); }
        signal.throwIfAborted();
        return { id, mime: 'image/svg+xml', width: size.width, height: size.height, animated: false, duration: null };
    }
    const result = await call<WorkerInspection>('inspect', { blob }, 10000);
    signal.throwIfAborted();
    if (!result || typeof result !== 'object' || typeof result.id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(result.id)
        || !MEDIA_MIMES.includes(result.mime) || !validSize(result.width, result.height) || typeof result.animated !== 'boolean'
        || !Number.isSafeInteger(result.decodePixels) || result.decodePixels < result.width * result.height || result.decodePixels > 2 ** 26) {
        throw new Error('Invalid media worker reply');
    }
    const lease = options.memory.reserve(4 * result.decodePixels);
    if (!lease) throw new Error('Not enough memory to decode this media');
    try {
        let duration: number | null = null;
        if (result.mime.startsWith('video/')) {
            const transport = options.memory.reserve(blob.size * 3);
            if (!transport) throw new Error('Not enough memory for contained video transfer');
            try {
                const probed = await videoFrameInProfile(blob, result, options.identity, options.isCurrent, signal, 'probe');
                if (typeof probed !== 'number') { if (probed instanceof ImageBitmap) probed.close(); throw new Error('Invalid contained video probe'); }
                duration = probed;
            } finally { options.memory.release(transport); }
        }
        if (duration === null) {
            try {
                await call<boolean>('probe', { blob, width: result.width, height: result.height, animated: result.animated, mime: result.mime }, 10000);
            } catch (error) {
                // Only cancellation can leave the native decoder running after the request settles.
                if (signal.aborted) await worker.recycle('cancelled image probe').catch(() => undefined);
                throw error;
            }
        }
        signal.throwIfAborted();
        return { id: result.id, mime: result.mime, width: result.width, height: result.height, animated: result.animated, duration };
    } finally { options.memory.release(lease); }
}
