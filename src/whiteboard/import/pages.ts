import { backdropRole, type LegacyShape } from './records/common';

// IMP-3, E-IMP-7/9: legacy rectangles come from the saved backdrop, not a new PDF layout.
export interface LegacyPageRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface DisplayPage { readonly w: number; readonly h: number }
export interface LegacyPageMapping { readonly rect: LegacyPageRect; readonly scale: number }

export function mapLegacyPdfPages(rects: readonly LegacyPageRect[], pages: readonly DisplayPage[]): readonly LegacyPageMapping[] {
    if (rects.length !== pages.length || !rects.length) throw new Error('Missing saved PDF page geometry');
    return rects.map((rect, index) => {
        const page = pages[index];
        if (![rect.x, rect.y, rect.w, rect.h, page.w, page.h].every(Number.isFinite)
            || rect.w <= 0 || rect.h <= 0 || page.w <= 0 || page.h <= 0) {
            throw new Error(`Invalid geometry for page ${index + 1}`);
        }
        const scale = page.w / rect.w;
        if (Math.abs((rect.w / rect.h) / (page.w / page.h) - 1) > 0.005) {
            throw new Error(`Page ${index + 1} changed aspect ratio`);
        }
        return { rect, scale };
    });
}

export function legacyPdfPages(shapes: readonly LegacyShape[], pages: readonly DisplayPage[]): readonly LegacyPageMapping[] {
    const rects: (LegacyPageRect | undefined)[] = new Array(pages.length);
    for (const shape of shapes) {
        if (backdropRole(shape, 'pdf-ink') !== 'backdrop') continue;
        const index = shape.meta.pdfPage;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= pages.length || rects[index]) {
            throw new Error('Invalid or duplicate saved PDF page geometry');
        }
        const { w, h } = shape.props;
        if (typeof w !== 'number' || typeof h !== 'number') throw new Error(`Missing geometry for page ${index + 1}`);
        rects[index] = { x: shape.x, y: shape.y, w, h };
    }
    if (rects.some(rect => rect === undefined) || rects.filter(Boolean).length !== pages.length) {
        throw new Error('Missing saved PDF page geometry');
    }
    return mapLegacyPdfPages(rects as LegacyPageRect[], pages);
}

export function notebookPages(width: number, height: number, count: number): readonly LegacyPageMapping[] {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
        || !Number.isInteger(count) || count < 1 || count > 500) throw new Error('Invalid notebook paper');
    return Array.from({ length: count }, (_, index) => ({
        rect: { x: 0, y: index * (height + 24), w: width, h: height }, scale: 1,
    }));
}

export function locateLegacyPage(pages: readonly LegacyPageMapping[], x: number, y: number, centreY: number): {
    readonly page: number; readonly x: number; readonly y: number; readonly scale: number; readonly pastEnd: boolean;
} {
    if (!pages.length || ![x, y, centreY].every(Number.isFinite)) throw new Error('Invalid page position');
    // A gap belongs to the following page; outlying coordinates stay relative to the nearest page.
    let page = pages.findIndex(({ rect }) => centreY < rect.y + rect.h);
    if (page < 0) page = pages.length - 1;
    const { rect, scale } = pages[page];
    return { page, x: (x - rect.x) * scale, y: (y - rect.y) * scale, scale,
        pastEnd: centreY >= pages[pages.length - 1].rect.y + pages[pages.length - 1].rect.h };
}
