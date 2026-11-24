import type { Rect } from '../types';

/** World units (PDF points), never CSS/device pixels (contracts.md C1.5:213–214). */
export const PAGE_GAP = 24;

/** One shared layout for View, Annotate, notebooks and export (contracts.md C1.5:203–226). */
export interface PageStack {
    rects: Rect[];
    width: number;
    height: number;
}

/** Centres each page on the widest one; no trailing gap is part of the document (C1.5:213–218). */
export function pageStack(pages: readonly { width: number; height: number }[]): PageStack {
    let width = 0;
    for (const page of pages) {
        if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width < 0 || page.height < 0) {
            throw new RangeError('Page dimensions must be finite and nonnegative');
        }
        width = Math.max(width, page.width);
    }
    const rects: Rect[] = [];
    let height = 0;
    for (const page of pages) {
        if (rects.length) height += PAGE_GAP;
        rects.push({ x: (width - page.width) / 2, y: height, width: page.width, height: page.height });
        height += page.height;
        if (!Number.isFinite(height)) throw new RangeError('Page stack exceeds finite world coordinates');
    }
    return { rects, width, height };
}

/** Gaps belong to the following page; endpoints clamp to the first/last (C1.5:221–223).
 * Contract silent on empty stacks; vr-lead ruling: -1 means "no page", never a fictitious page 0.
 */
export function pageAt(stack: Readonly<PageStack>, worldY: number): number {
    if (!Number.isFinite(worldY)) throw new RangeError('Page position must be finite');
    if (!stack.rects.length) return -1;
    let low = 0;
    let high = stack.rects.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const rect = stack.rects[middle];
        if (worldY < rect.y + rect.height) high = middle;
        else low = middle + 1;
    }
    return Math.min(low, stack.rects.length - 1);
}
