import type { Affine, Rect, ViewState } from '../types';
import { pagePresentation } from './camera';
import type { CompositorPage } from './compositor.types';
import type { PageStack } from './pageStack';
import type { ReadySurfaceMetrics } from './surfaceMetrics';

export function projectPage(stack: Readonly<PageStack> | null, view: ViewState, index: number): CompositorPage | null {
    if (!stack || !Number.isSafeInteger(index) || index < 0 || index >= stack.rects.length) return null;
    const rect = stack.rects[index];
    const presentation = pagePresentation(rect, view);
    const outline: Rect = { x: presentation.device[4], y: presentation.device[5],
        width: rect.width * presentation.device[0], height: rect.height * presentation.device[3] };
    const width = Math.round(view.viewport.width * view.viewport.dpr);
    const height = Math.round(view.viewport.height * view.viewport.dpr);
    const left = Math.max(0, Math.min(width, Math.floor(outline.x)));
    const top = Math.max(0, Math.min(height, Math.floor(outline.y)));
    const right = Math.max(left, Math.min(width, Math.ceil(outline.x + outline.width)));
    const bottom = Math.max(top, Math.min(height, Math.ceil(outline.y + outline.height)));
    return { index, rect, presentation, outline,
        clip: { x: left, y: top, width: right - left, height: bottom - top } };
}

export function worldDeviceTransform(view: ViewState): Affine {
    const scale = view.camera.z * view.viewport.dpr;
    return [scale, 0, 0, scale, -view.camera.x * scale, -view.camera.y * scale];
}

export function paneCssTransform(view: ViewState, prepared: ViewState, metrics: ReadySurfaceMetrics | null): Affine | null {
    if (!metrics || view.epoch !== prepared.epoch || view.camera.x !== prepared.camera.x || view.camera.y !== prepared.camera.y
        || view.camera.z !== prepared.camera.z || view.viewport.width !== prepared.viewport.width
        || view.viewport.height !== prepared.viewport.height || view.viewport.dpr !== prepared.viewport.dpr
        || view.viewport.width !== metrics.viewport.width || view.viewport.height !== metrics.viewport.height
        || view.viewport.dpr !== metrics.viewport.dpr || metrics.backingWidth <= 0 || metrics.backingHeight <= 0
        || metrics.viewport.width <= 0 || metrics.viewport.height <= 0 || view.camera.z <= 0 || view.viewport.dpr <= 0) return null;
    const device = worldDeviceTransform(prepared);
    const x = metrics.viewport.width / metrics.backingWidth, y = metrics.viewport.height / metrics.backingHeight;
    const result: Affine = [device[0] * x, device[1] * y, device[2] * x, device[3] * y, device[4] * x, device[5] * y];
    return result.every(Number.isFinite) ? Object.freeze(result) : null;
}

export function paintWorldScope(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void {
    ctx.save();
    try {
        ctx.setTransform(...worldDeviceTransform(view));
        paint();
    } finally { ctx.restore(); }
}

export function paintPageScope(ctx: CanvasRenderingContext2D, page: CompositorPage | null, paint: () => void): void {
    if (!page || !page.clip.width || !page.clip.height) return;
    ctx.save();
    try {
        ctx.resetTransform();
        ctx.beginPath();
        ctx.rect(page.outline.x, page.outline.y, page.outline.width, page.outline.height);
        ctx.clip();
        ctx.setTransform(...page.presentation.device);
        paint();
    } finally { ctx.restore(); }
}
