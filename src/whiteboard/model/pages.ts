import { pageAt, type PageStack } from '../../platform/render/pageStack';
import type { Affine, Rect } from '../../platform/types';

export interface PageAnchor {
    readonly page: number;
    readonly x: number;
    readonly y: number;
}

export type PageMove = PageAnchor;

// Missing PDF pages retain their stored index; only their displayed origin is clamped (E-DOC-14).
export function pageOrigin(stack: Readonly<PageStack>, page: number): Rect | undefined {
    if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('Invalid page index');
    return stack.rects[Math.min(page, stack.rects.length - 1)];
}

export function pageWorldTransform(
    stack: Readonly<PageStack>, anchor: PageAnchor & { readonly rotation: number },
): Affine | undefined {
    const origin = pageOrigin(stack, anchor.page);
    if (!origin) return undefined;
    const cos = Math.cos(anchor.rotation), sin = Math.sin(anchor.rotation);
    return [cos, sin, -sin, cos, origin.x + anchor.x, origin.y + anchor.y];
}

// Called only at commit: during a gesture the original page remains the anchor.
export function reanchorPage(
    stack: Readonly<PageStack>, anchor: PageAnchor, worldBounds: Readonly<Rect>,
): PageMove | undefined {
    const origin = pageOrigin(stack, anchor.page);
    if (!origin) return undefined;
    const page = pageAt(stack, worldBounds.y + worldBounds.height / 2);
    const target = stack.rects[page];
    return { page, x: anchor.x + origin.x - target.x, y: anchor.y + origin.y - target.y };
}
