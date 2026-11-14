import type { Rect, ViewState } from '../types';
import { pagePresentation } from './camera';
import type { CompositorPage } from './compositor.types';
import type { PageStack } from './pageStack';

/** The fractional outline and its integer scissor envelope are different (design §4.1:396–399).
 * Both backends use the camera's ONE page-rest correction, including for input/overlays (C1.2).
 */
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

/** Scopes restore even if a producer throws; layers receive the original ViewState (C4.3; design §4.1). */
export function paintWorldScope(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void {
    const scale = view.camera.z * view.viewport.dpr;
    ctx.save();
    try {
        ctx.setTransform(scale, 0, 0, scale, -view.camera.x * scale, -view.camera.y * scale);
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
