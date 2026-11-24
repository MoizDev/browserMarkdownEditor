import { PdfEngineError } from '../engine/types';
import type { RenderJob, RenderPixels } from '../engine/types';
import type { CopiedTile, RenderSliceHooks, RenderTileBounds } from './renderJob.types';

function copyTile(rendered: RenderPixels, bounds: RenderTileBounds): CopiedTile {
    const { rect, maxTileEdge, maxTileBytes } = bounds;
    const w = rect.w + 2, h = rect.h + 2, rowBytes = w * 4, bytes = rowBytes * h;
    if (![rect.x, rect.y, rect.w, rect.h, w, h, rowBytes, bytes, maxTileEdge, maxTileBytes].every(Number.isSafeInteger) ||
        rect.w <= 0 || rect.h <= 0 || w > maxTileEdge || h > maxTileEdge || bytes > maxTileBytes ||
        rendered.w !== w || rendered.h !== h || rendered.originX !== rect.x - 1 || rendered.originY !== rect.y - 1 ||
        !Number.isSafeInteger(rendered.stride) || rendered.stride < rowBytes ||
        !(rendered.pixels instanceof Uint8Array) ||
        (h - 1) * rendered.stride + rowBytes > rendered.pixels.byteLength) {
        throw new PdfEngineError('EngineBroken', 'Invalid PDF tile pixels from backend');
    }
    const output = new Uint8Array(bytes);
    for (let y = 0; y < h; y++) {
        const source = rendered.pixels.subarray(y * rendered.stride, y * rendered.stride + rowBytes);
        for (let x = 3; x < rowBytes; x += 4) {
            if (source[x] !== 255) throw new PdfEngineError('EngineBroken', 'PDF tile is not opaque');
        }
        output.set(source, y * rowBytes);
    }
    return { pixels: output.buffer, w, h, originX: rect.x - 1, originY: rect.y - 1 };
}

/** One dispatcher-owned native job, with cancellation and heartbeats between
 * slices. The fresh output owns its bytes before native storage is released. */
export async function runPdfRenderJob(job: RenderJob, bounds: RenderTileBounds, hooks: RenderSliceHooks): Promise<CopiedTile> {
    const channel = new MessageChannel();
    let wake: (() => void) | undefined;
    const onAbort = () => { wake?.(); };
    hooks.signal.addEventListener('abort', onAbort);
    try {
        for (;;) {
            if (hooks.signal.aborted) throw new PdfEngineError('AbortError', 'PDF tile was cancelled');
            const state = job.step(8);
            hooks.heartbeat();
            if (hooks.signal.aborted) throw new PdfEngineError('AbortError', 'PDF tile was cancelled');
            if (state === 'done') return copyTile(job.result(), bounds);
            if (state !== 'more') throw new PdfEngineError('EngineBroken', 'Invalid PDF render job state');
            if (hooks.cooperate) await hooks.cooperate();
            else await new Promise<void>(resolve => {
                wake = resolve;
                channel.port1.onmessage = () => { wake = undefined; resolve(); };
                channel.port2.postMessage(0);
                if (hooks.signal.aborted) resolve();
            });
            wake = undefined;
        }
    } finally {
        hooks.signal.removeEventListener('abort', onAbort);
        channel.port1.close(); channel.port2.close();
        job.abort();
    }
}
