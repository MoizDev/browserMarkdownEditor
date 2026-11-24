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
        const boundsRight = bounds.x + bounds.width, boundsBottom = bounds.y + bounds.height;
        const targetRight = origin.x + ctx.canvas.width, targetBottom = origin.y + ctx.canvas.height;
        if (![boundsRight, boundsBottom, targetRight, targetBottom].every(Number.isSafeInteger)) throw new CaptureError('invalid-input');
        if (ctx.isContextLost()) throw new CaptureError('render-failed');
        if (!options.opacity) return;
        const left = Math.max(origin.x, bounds.x), top = Math.max(origin.y, bounds.y);
        const right = Math.min(targetRight, boundsRight);
        const bottom = Math.min(targetBottom, boundsBottom);
        if (right <= left || bottom <= top) return;
        const width = right - left, height = bottom - top;
        const bytes = width * height * RENDER_CONSTANTS.surfaceReserveBytesPerPixel;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(bytes)) throw new CaptureError('invalid-input');
        const lease = memory.reserve(bytes);
        if (!lease) throw new CaptureError('out-of-budget');
        let canvas: HTMLCanvasElement | undefined;
        try {
            canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            if (canvas.width !== width || canvas.height !== height) throw new CaptureError('render-failed');
            const native = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' });
            if (!native || native.isContextLost()) throw new CaptureError('render-failed');
            const isolated = deviceContext(native, { x: left, y: top }, (_source, _src, _dst, draw) => draw());
            const scope = Proxy.revocable(isolated, {});
            origins.set(scope.proxy, { x: left, y: top });
            registerCanvasIsolation(scope.proxy, painter);
            const properties = ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
                'font', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering', 'textAlign', 'textBaseline', 'direction',
                'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'filter', 'imageSmoothingEnabled', 'imageSmoothingQuality',
                'globalAlpha', 'globalCompositeOperation'] as const;
            try {
                for (const property of properties) Reflect.set(scope.proxy, property, Reflect.get(ctx, property));
                scope.proxy.setLineDash(ctx.getLineDash()); scope.proxy.setTransform(ctx.getTransform());
                scope.proxy.beginPath(); paint(scope.proxy);
            } finally { scope.revoke(); }
            if (native.isContextLost() || ctx.isContextLost()) throw new CaptureError('render-failed');
            ctx.save();
            try {
                ctx.resetTransform(); ctx.globalAlpha = options.opacity;
                ctx.globalCompositeOperation = options.blend === 'multiply' ? 'multiply' : 'source-over';
                ctx.drawImage(canvas, left, top);
                if (native.isContextLost() || ctx.isContextLost()) throw new CaptureError('render-failed');
            } finally { ctx.restore(); }
        } finally {
            try { if (canvas) { canvas.width = 0; canvas.height = 0; } }
            finally { memory.release(lease); }
        }
    };
    registerCanvasIsolation(root, painter);
}
