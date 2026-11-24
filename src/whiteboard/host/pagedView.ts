import { cameraForPagedPosition, fitWidthZ, pagedConstraint, pagedPosition,
    type PagedPosition, type ViewportInsets, type ZoomLimits } from '../../platform/render/camera';
import type { PageStack } from '../../platform/render/pageStack';
import type { Camera, Viewport } from '../../platform/types';

export const NOTEBOOK_INSETS: Readonly<ViewportInsets> = Object.freeze({ left: 0, right: 0, top: 56, bottom: 0 });
export const PDF_INK_INSETS: Readonly<ViewportInsets> = Object.freeze({ left: 0, right: 0, top: 16, bottom: 0 });

function clampCamera(camera: Camera, viewport: Viewport, stack: Readonly<PageStack>, insets: ViewportInsets, limits: ZoomLimits): Camera {
    const bounds = pagedConstraint(stack, limits, insets).bounds(camera, viewport);
    return { ...camera, x: Math.min(bounds.maxX, Math.max(bounds.minX, camera.x)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, camera.y)) };
}

/** Jump retains the exact zoom and centers the selected physical page, subject to document bounds. */
export function jumpToPhysicalPage(
    camera: Camera, viewport: Viewport, stack: Readonly<PageStack>, page: number, insets: ViewportInsets, limits: ZoomLimits,
): Camera | null {
    if (!Number.isInteger(page) || page < 0 || page >= stack.rects.length) throw new RangeError('Invalid page');
    const fit = fitWidthZ(viewport, stack, insets);
    if (!fit) return null;
    const rect = stack.rects[page];
    const next = cameraForPagedPosition({ page, offset: 0, zoom: camera.z / fit }, viewport, stack,
        insets, limits, rect.x + rect.width / 2);
    return next && clampCamera(next, viewport, stack, insets, limits);
}

/** Keep the physical page and offset when paper geometry changes, without scaling content or zoom. */
export function reframePaper(
    camera: Camera, viewport: Viewport, previous: Readonly<PageStack>, next: Readonly<PageStack>,
    insets: ViewportInsets, limits: ZoomLimits,
): Camera | null {
    const position = pagedPosition(camera, viewport, previous, insets);
    const fit = fitWidthZ(viewport, next, insets);
    if (!position || !fit || !next.rects.length) return null;
    const page = Math.min(position.page, next.rects.length - 1);
    const rect = next.rects[page];
    const restore: PagedPosition = { page, offset: position.offset, zoom: camera.z / fit };
    const result = cameraForPagedPosition(restore, viewport, next, insets, limits, rect.x + rect.width / 2);
    return result && clampCamera(result, viewport, next, insets, limits);
}
