import type { Rect } from '../../platform/types';

/** Transferred selection geometry from one physical page, in page space. */
export interface PdfHighlightGeometry {
    readonly charU16: Uint32Array;
    readonly loose: Float32Array;
    readonly flags: Uint8Array;
    /** First and exclusive-last character index for every line. */
    readonly lines: Uint32Array;
    /** Unit writing direction, two floats per line. */
    readonly lineDir: Float32Array;
}
interface Glyph { index: number; from: number; to: number; rect: Rect; coordinate: number }

/** Yield a line at a time so a large page can be prepared within the frame budget.
 * Bounding boxes merge only across consecutive visual glyphs with nearly identical
 * cross-axis extents. Otherwise the bounding rectangle would paint outside the ink.
 */
export function* pdfHighlightRuns(geometry: PdfHighlightGeometry, from: number, to: number,
    onePixelInPage: number): Generator<readonly Rect[]> {
    const low = Math.max(0, Math.min(from, to)), high = Math.max(low, Math.max(from, to));
    const tolerance = Number.isFinite(onePixelInPage) ? Math.max(0, onePixelInPage) : 0;
    const count = Math.min(geometry.flags.length, Math.max(0, geometry.charU16.length - 1), Math.floor(geometry.loose.length / 4));
    for (let line = 0; line + 1 < geometry.lines.length; line += 2) {
        const dx = geometry.lineDir[line] ?? 1, dy = geometry.lineDir[line + 1] ?? 0;
        const horizontal = Math.abs(dx) > 0.999, vertical = Math.abs(dy) > 0.999;
        const glyphs: Glyph[] = [];
        for (let index = Math.min(count, geometry.lines[line]); index < Math.min(count, geometry.lines[line + 1]); index++) {
            if (geometry.flags[index] & 16) continue;
            const x0 = geometry.loose[index * 4], y0 = geometry.loose[index * 4 + 1];
            const x1 = geometry.loose[index * 4 + 2], y1 = geometry.loose[index * 4 + 3];
            if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
            glyphs.push({ index, from: geometry.charU16[index], to: geometry.charU16[index + 1],
                rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
                coordinate: (x0 + x1) * dx + (y0 + y1) * dy });
        }
        glyphs.sort((a, b) => a.coordinate - b.coordinate || a.index - b.index);
        const runs: Rect[] = [];
        let previous: Rect | undefined;
        for (const glyph of glyphs) {
            if (glyph.to <= glyph.from || glyph.from >= high || glyph.to <= low) { previous = undefined; continue; }
            const rect = glyph.rect;
            let merge = false;
            if (previous && horizontal) {
                const gap = Math.max(0, rect.x - (previous.x + previous.width), previous.x - (rect.x + rect.width));
                merge = gap <= tolerance * 2 && Math.abs(rect.y - previous.y) <= tolerance &&
                    Math.abs(rect.y + rect.height - previous.y - previous.height) <= tolerance;
            } else if (previous && vertical) {
                const gap = Math.max(0, rect.y - (previous.y + previous.height), previous.y - (rect.y + rect.height));
                merge = gap <= tolerance * 2 && Math.abs(rect.x - previous.x) <= tolerance &&
                    Math.abs(rect.x + rect.width - previous.x - previous.width) <= tolerance;
            }
            if (previous && merge) {
                const right = Math.max(previous.x + previous.width, rect.x + rect.width);
                const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
                previous.x = Math.min(previous.x, rect.x); previous.y = Math.min(previous.y, rect.y);
                previous.width = right - previous.x; previous.height = bottom - previous.y;
            } else { previous = { ...rect }; runs.push(previous); }
        }
        yield runs;
    }
}
