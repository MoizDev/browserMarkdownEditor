import type { Rect } from '../types';
import type { CaptureOptions, CaptureRequest, CaptureSnapshot, CapturedLayer } from './capture';
import { CaptureError } from './captureError';
import { captureIsolation2d } from './captureIsolation2d';
import type { MemoryAllocator } from './memoryGovernor';

export interface CaptureExportOptions extends CaptureOptions {
    readonly clipboard?: boolean;
    readonly pixelsPerWorldUnit?: number;
}
export interface CaptureExportTile { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type CaptureExportRenderer = (tile: CaptureExportTile, signal?: AbortSignal) => Promise<Uint8Array>;
export type CapturePngEncoder = (width: number, height: number, render: CaptureExportRenderer,
    options: Readonly<{ signal: AbortSignal; clipboard?: boolean; pixelsPerWorldUnit?: number; memory: MemoryAllocator }>) => Promise<Blob>;

export async function renderCaptureExport(request: CaptureRequest, snapshot: CaptureSnapshot, layers: readonly CapturedLayer[],
    memory: MemoryAllocator, encoder: CapturePngEncoder, signal: AbortSignal, check: () => void,
    options: CaptureExportOptions): Promise<Blob> {
    const prepareTile = snapshot.prepareTile;
    if (!prepareTile) throw new CaptureError('incomplete');
    const { width, height } = request.view.viewport, scale = request.view.camera.z;
    let lastPixels: { release(): void } | null = null;
    let inFlight: Promise<Uint8Array> | null = null, sequence = 0;
    const drain = async () => { await inFlight?.catch(() => {}); lastPixels?.release(); };
    const render: CaptureExportRenderer = (tile, encoderSignal) => {
        if (inFlight) return Promise.reject(new CaptureError('invalid-input'));
        const task = (async () => {
            check();
            if (![tile.x, tile.y, tile.width, tile.height].every(Number.isSafeInteger) || tile.x < 0 || tile.y < 0
                || tile.width < 1 || tile.height < 1 || tile.width > 1024 || tile.height > 1024
                || tile.x + tile.width > width || tile.y + tile.height > height) throw new CaptureError('invalid-input');
            lastPixels?.release(); lastPixels = null;
            const combined = encoderSignal ? AbortSignal.any([signal, encoderSignal]) : signal;
            const current = () => { check(); combined.throwIfAborted(); };
            current();
            const apron = 2, w = tile.width + 2 * apron, h = tile.height + 2 * apron;
            const backing = memory.reserve(w * h * 4);
            if (!backing) throw new CaptureError('out-of-budget');
            const pixels = memory.reserve(tile.width * tile.height * 4);
            if (!pixels) { memory.release(backing); throw new CaptureError('out-of-budget'); }
            let retained = false, canvas: HTMLCanvasElement | null = null;
            try {
                const x = request.worldRect.x + (tile.x - apron) / scale;
                const y = request.worldRect.y + (tile.y - apron) / scale;
                const worldRect: Readonly<Rect> = Object.freeze({ x, y, width: w / scale, height: h / scale });
                const part: CaptureRequest = Object.freeze({ ...request, worldRect,
                    view: Object.freeze({ camera: Object.freeze({ x, y, z: scale }),
                        viewport: Object.freeze({ width: w, height: h, dpr: 1 }), epoch: ++sequence, moving: false }) });
                const completeness = await prepareTile.call(snapshot, part, combined);
                current();
                if (completeness !== 'exact' && !(request.policy === 'allow-standin' && completeness === 'standin')) {
                    throw new CaptureError('incomplete');
                }
                canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
                if (canvas.width !== w || canvas.height !== h) throw new CaptureError('render-failed');
                const ctx = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
                if (!ctx || ctx.isContextLost()) throw new CaptureError('render-failed');
                captureIsolation2d(ctx, memory);
                ctx.beginPath();
                ctx.rect(apron - tile.x, apron - tile.y, request.worldRect.width * scale, request.worldRect.height * scale);
                ctx.clip();
                for (const layer of layers) {
                    current(); ctx.save();
                    try { layer.draw2d(ctx, part.view); } finally { ctx.restore(); }
                }
                if (ctx.isContextLost()) throw new CaptureError('render-failed');
                const image = ctx.getImageData(apron, apron, tile.width, tile.height);
                current();
                let held = true;
                lastPixels = { release() { if (held) { held = false; memory.release(pixels); } } };
                retained = true;
                return new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
            } finally {
                if (canvas) { canvas.width = 0; canvas.height = 0; }
                memory.release(backing);
                if (!retained) memory.release(pixels);
            }
        })();
        inFlight = task;
        void task.finally(() => { if (inFlight === task) inFlight = null; }).catch(() => {});
        return task;
    };
    try {
        check();
        const result = await encoder(width, height, render, { signal, clipboard: options.clipboard,
            pixelsPerWorldUnit: options.pixelsPerWorldUnit, memory });
        check();
        if (!(result instanceof Blob) || result.type !== 'image/png' || !result.size) throw new CaptureError('render-failed');
        return result;
    } finally {
        // Encoder cancellation may settle its caller before an already-started native prepare.
        // That work, not the caller's rejected promise, owns the root capture slot and leases.
        await drain();
    }
}
