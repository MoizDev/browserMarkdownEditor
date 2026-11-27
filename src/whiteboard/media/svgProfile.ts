import { cpuGovernor } from '../../platform/workers';
import { boardWorker } from '../workers/client';
import { matchingIdentity } from '../workers/protocol';
import type { InspectedMedia } from './ingest';
import type { SvgAdmissionProfile } from './inspect';
import type { BoardJobIdentity } from '../workers/protocol';
import type { MediaRasterGeometry } from './mips';
import { svgFrameFactory } from './svgFrameHost';

export interface SvgContainedFrame {
    request(operation: 'header' | 'probe' | 'raster' | 'full-frame', blob: Blob, signal: AbortSignal,
        size?: { readonly width: number; readonly height: number; readonly raster?: MediaRasterGeometry }): Promise<unknown>;
    dispose(): void;
}
export interface SvgFrameFactory {
    open(profile: 'svg-xml' | 'svg-image', signal: AbortSignal, identity: BoardJobIdentity): Promise<SvgContainedFrame>;
}

export function createSvgAdmissionProfile(frames: SvgFrameFactory, identity: BoardJobIdentity, isCurrent: (identity: BoardJobIdentity) => boolean): SvgAdmissionProfile {
    const request = async (profile: 'svg-xml' | 'svg-image', op: 'header' | 'probe', blob: Blob, signal: AbortSignal, size?: { readonly width: number; readonly height: number }): Promise<unknown> => {
        signal.throwIfAborted();
        if (!isCurrent(identity)) throw new DOMException('Stale SVG job', 'AbortError');
        const frame = await frames.open(profile, signal, identity);
        try {
            signal.throwIfAborted();
            if (!isCurrent(identity)) throw new DOMException('Stale SVG job', 'AbortError');
            const result = await frame.request(op, blob, signal, size);
            if (!isCurrent(identity)) throw new DOMException('Stale SVG job', 'AbortError');
            return result;
        } finally { frame.dispose(); }
    };
    return {
        async header(blob, signal) {
            const result = await request('svg-xml', 'header', blob, signal);
            if (!result || typeof result !== 'object') throw new Error('Invalid SVG decoder response');
            const { width, height, rgbaBytes } = result as { width?: unknown; height?: unknown; rgbaBytes?: unknown };
            if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
                || width < 1 || height < 1 || width > (2 ** 26) / height
                || typeof rgbaBytes !== 'number' || !Number.isSafeInteger(rgbaBytes)
                || rgbaBytes < width * height * 4 || rgbaBytes > 4 * (2 ** 26)) throw new Error('Invalid SVG decoder response');
            return { width, height, rgbaBytes };
        },
        async probe(blob, width, height, signal) {
            const result = await request('svg-image', 'probe', blob, signal, { width, height });
            if (result !== true) throw new Error('This picture could not be read');
        },
    };
}

let fullFrameJob = 0;
export function createIsolatedFullFrameSvgDecoder(isCurrent: (identity: BoardJobIdentity) => boolean):
    (blob: Blob, info: InspectedMedia, identity: BoardJobIdentity, signal: AbortSignal) => Promise<ImageBitmap> {
    return async (blob, info, identity, signal) => {
        signal.throwIfAborted();
        if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File) || blob.size > 5 * 1024 * 1024
            || info.mime !== 'image/svg+xml' || !/^sha256:[0-9a-f]{64}$/.test(info.id)
            || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
            || info.width < 1 || info.height < 1 || info.width > (2 ** 26) / info.height || !isCurrent(identity)) throw new TypeError('Invalid full-frame SVG request');
        const pinned = Object.freeze({ ...identity });
        const current = (value: BoardJobIdentity) => !signal.aborted && matchingIdentity(value, pinned) && isCurrent(pinned);
        const worker = boardWorker('decode');
        let preflight: boolean, hash: string;
        try {
            preflight = await worker.request<boolean>('svgPreflight', { blob }, pinned, { priority: 0, deadlineMs: 5000, signal }, current);
            if (preflight !== true) throw new Error('Invalid SVG preflight response');
            hash = await worker.request<string>('hash', { blob }, pinned, { priority: 0, deadlineMs: 10000, signal }, current);
        } catch (error) {
            if (signal.aborted) await worker.recycle('SVG preparation cancelled').catch(() => undefined);
            throw error;
        }
        signal.throwIfAborted();
        if (!current(pinned) || hash !== info.id) throw new Error('Full-frame SVG hash mismatch');
        const permit = cpuGovernor.acquire({ name: 'whiteboard-svg-full-frame', id: ++fullFrameJob, priority: 0,
            start() {}, pause() {}, resume() {} });
        if (!permit.held) { permit.release(); throw new Error('SVG full-frame CPU permit unavailable'); }
        let frame: SvgContainedFrame | undefined, result: unknown;
        try {
            const size = await createSvgAdmissionProfile(svgFrameFactory, pinned, current).header(blob, signal);
            signal.throwIfAborted();
            if (!current(pinned) || size.width !== info.width || size.height !== info.height) throw new Error('Full-frame SVG header mismatch');
            frame = await svgFrameFactory.open('svg-image', signal, pinned);
            result = await frame.request('full-frame', blob, signal, { width: info.width, height: info.height });
            signal.throwIfAborted();
            if (!current(pinned) || !(result instanceof ImageBitmap) || result.width !== info.width || result.height !== info.height) throw new Error('Invalid full-frame SVG result');
            const bitmap = result; result = undefined; return bitmap;
        } finally {
            if (result instanceof ImageBitmap) result.close();
            frame?.dispose(); permit.release();
        }
    };
}

export async function rasterSvgInProfile(frames: SvgFrameFactory, blob: Blob, width: number, height: number,
    raster: MediaRasterGeometry, identity: BoardJobIdentity, isCurrent: (identity: BoardJobIdentity) => boolean,
    signal: AbortSignal): Promise<ImageBitmap> {
    signal.throwIfAborted();
    if (!isCurrent(identity)) throw new DOMException('Stale SVG job', 'AbortError');
    const frame = await frames.open('svg-image', signal, identity);
    let result: unknown;
    try {
        result = await frame.request('raster', blob, signal, { width, height, raster });
        if (!(result instanceof ImageBitmap)) throw new Error('Invalid SVG raster reply');
        if (!isCurrent(identity) || signal.aborted || result.width !== raster.width || result.height !== raster.height) {
            result.close(); result = undefined;
            throw new DOMException('Stale SVG raster', 'AbortError');
        }
        return result;
    } catch (error) {
        if (result instanceof ImageBitmap) result.close();
        throw error;
    } finally { frame.dispose(); }
}
