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
        const chunks: Glyph[][] = [];
        let chunk: Glyph[] = [], scanned = 0;
        const compare = (a: Glyph, b: Glyph) => a.coordinate - b.coordinate || a.index - b.index;
        for (let index = Math.min(count, geometry.lines[line]); index < Math.min(count, geometry.lines[line + 1]); index++) {
            if (++scanned === 256) {
                if (chunk.length) { chunk.sort(compare); chunks.push(chunk); chunk = []; }
                scanned = 0; yield [];
            }
            if (geometry.flags[index] & 16) continue;
            const x0 = geometry.loose[index * 4], y0 = geometry.loose[index * 4 + 1];
            const x1 = geometry.loose[index * 4 + 2], y1 = geometry.loose[index * 4 + 3];
            if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
            chunk.push({ index, from: geometry.charU16[index], to: geometry.charU16[index + 1],
                rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
                coordinate: (x0 + x1) * dx + (y0 + y1) * dy });
        }
        if (chunk.length) { chunk.sort(compare); chunks.push(chunk); }
        // A heap merges bounded sorted chunks without one uninterruptible sort
        // on a hostile page containing hundreds of thousands of characters.
        const heap: { glyph: Glyph; chunk: number; next: number }[] = [];
        const push = (item: typeof heap[number]) => {
            let i = heap.length; heap.push(item);
            while (i > 0) { const parent = (i - 1) >> 1; if (compare(heap[parent].glyph, item.glyph) <= 0) break; heap[i] = heap[parent]; i = parent; }
            heap[i] = item;
        };
        const pop = () => {
            const first = heap[0], last = heap.pop()!;
            if (heap.length) {
                let i = 0;
                while (i * 2 + 1 < heap.length) {
                    let child = i * 2 + 1;
                    if (child + 1 < heap.length && compare(heap[child + 1].glyph, heap[child].glyph) < 0) child++;
                    if (compare(last.glyph, heap[child].glyph) <= 0) break;
                    heap[i] = heap[child]; i = child;
                }
                heap[i] = last;
            }
            return first;
        };
        chunks.forEach((items, index) => push({ glyph: items[0], chunk: index, next: 1 }));
        let runs: Rect[] = [], previous: Rect | undefined, processed = 0;
        while (heap.length) {
            const entry = pop(), glyph = entry.glyph, next = chunks[entry.chunk][entry.next];
            if (next) push({ glyph: next, chunk: entry.chunk, next: entry.next + 1 });
            if (++processed === 256) {
                // Keep the final run mutable until the following glyph decides
                // whether it joins; completed runs may be published now.
                if (runs.length > 1) { yield runs.slice(0, -1); runs = [runs[runs.length - 1]]; }
                else yield [];
                processed = 0;
            }
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
