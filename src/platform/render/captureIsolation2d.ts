import { deviceContext, registerCanvasIsolation } from './canvas2dContext';
import { RENDER_CONSTANTS } from './constants';
import type { IsolationPaintOptions } from './compositor.types';
import type { RectI } from './gfx/api';
import type { MemoryAllocator } from './memoryGovernor';
import { CaptureError } from './captureError';

/** Captures own their CPU memory independently of any visible pane. Never borrow the selected
 * compositor's canvas: a capture may finish after its pane was hidden or the GPU was replaced.
 */
export function captureIsolation2d(root: CanvasRenderingContext2D, memory: MemoryAllocator): void {
    const origins = new WeakMap<CanvasRenderingContext2D, { x: number; y: number }>();
    origins.set(root, { x: 0, y: 0 });
    const painter = (ctx: CanvasRenderingContext2D, bounds: Readonly<RectI>, options: IsolationPaintOptions,
        paint: (isolatedCtx: CanvasRenderingContext2D) => void): void => {
        const origin = origins.get(ctx);
        if (!origin || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
            bounds.width < 0 || bounds.height < 0 || !Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1 ||
            !['normal', 'multiply'].includes(options.blend)) throw new CaptureError('invalid-input');
        if (!options.opacity) return;
        const left = Math.max(origin.x, bounds.x), top = Math.max(origin.y, bounds.y);
        const right = Math.min(origin.x + ctx.canvas.width, bounds.x + bounds.width);
        const bottom = Math.min(origin.y + ctx.canvas.height, bounds.y + bounds.height);
        if (right <= left || bottom <= top) return;
        const width = right - left, height = bottom - top;
        const lease = memory.reserve(width * height * RENDER_CONSTANTS.surfaceReserveBytesPerPixel);
        if (!lease) throw new CaptureError('out-of-budget');
        const canvas = document.createElement('canvas');
        try {
            canvas.width = width; canvas.height = height;
            const native = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
            if (!native) throw new CaptureError('render-failed');
            const isolated = deviceContext(native, { x: left, y: top }, (_source, _src, _dst, draw) => draw());
            origins.set(isolated, { x: left, y: top });
            registerCanvasIsolation(isolated, painter);
            const properties = ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
                'font', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering', 'textAlign', 'textBaseline', 'direction',
                'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'filter', 'imageSmoothingEnabled', 'imageSmoothingQuality',
                'globalAlpha', 'globalCompositeOperation'] as const;
            for (const property of properties) Reflect.set(isolated, property, Reflect.get(ctx, property));
            isolated.setLineDash(ctx.getLineDash()); isolated.setTransform(ctx.getTransform());
            isolated.beginPath(); paint(isolated);
            ctx.save();
            try {
                ctx.resetTransform(); ctx.globalAlpha = options.opacity;
                ctx.globalCompositeOperation = options.blend === 'multiply' ? 'multiply' : 'source-over';
                ctx.drawImage(canvas, left, top);
            } finally { ctx.restore(); }
        } finally { canvas.width = 0; canvas.height = 0; memory.release(lease); }
    };
    registerCanvasIsolation(root, painter);
}
