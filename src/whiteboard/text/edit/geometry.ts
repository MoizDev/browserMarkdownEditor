import type { Rect } from '../../../platform/types';

export interface TextTransform { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }

// EditContext accepts axis-aligned client rectangles even for rotated text.
export function clientBounds(rect: Rect, transform: TextTransform): DOMRect {
    const point = (x: number, y: number) => ({
        x: transform.a * x + transform.c * y + transform.e,
        y: transform.b * x + transform.d * y + transform.f,
    });
    const corners = [point(rect.x, rect.y), point(rect.x + rect.w, rect.y), point(rect.x, rect.y + rect.h), point(rect.x + rect.w, rect.y + rect.h)];
    const left = Math.min(...corners.map(p => p.x)), right = Math.max(...corners.map(p => p.x));
    const top = Math.min(...corners.map(p => p.y)), bottom = Math.max(...corners.map(p => p.y));
    return new DOMRect(left, top, right - left, bottom - top);
}
