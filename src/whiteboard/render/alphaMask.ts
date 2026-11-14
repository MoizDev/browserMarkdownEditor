/** Decoded alpha of one image in its own pixels, row-major, one byte per pixel. */
export interface AlphaMask {
    readonly width: number;
    readonly height: number;
    readonly alpha: Uint8Array | Uint8ClampedArray;
}

/**
 * Traces every pixel whose alpha is selected by `table` (a 256-entry lookup) into disjoint axis-aligned
 * rectangles, flattened as [x0, y0, x1, y1]. Each row's runs of selected pixels are merged with the
 * identical run directly above, so the rectangles are the exact union of the selected pixels and never
 * overlap. The generator yields every `rowsPerStep` rows so the caller can drive it cooperatively. It
 * returns null when the trace would exceed `maxRects`; the caller must then treat the whole mask as
 * uncertain rather than publish a partial outline.
 *
 * The output is bounded by the run count, not the pixel count: a dense photo with few runs stays small
 * and a fully selected tile collapses to one rectangle per row.
 */
export function* alphaRunSteps(mask: AlphaMask, table: Uint8Array, maxRects: number,
    rowsPerStep = 64): Generator<void, number[] | null, void> {
    const { width, height, alpha } = mask;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || alpha.length < width * height) {
        throw new RangeError('Alpha mask dimensions do not match its bytes');
    }
    if (table.length !== 256) throw new RangeError('Alpha selection table must cover every alpha value');
    if (!Number.isInteger(maxRects) || maxRects < 1) throw new RangeError('Alpha trace needs a positive rectangle budget');
    if (!Number.isInteger(rowsPerStep) || rowsPerStep < 1) throw new RangeError('Alpha trace rowsPerStep must be a positive integer');
    const stride = width + 1, rects: number[] = [];
    // An open rectangle is keyed by its run (x0, x1) and remembers the first row it covers.
    const open = new Map<number, number>();
    const close = (key: number, top: number, bottom: number): boolean => {
        if (rects.length >= 4 * maxRects) return false;
        rects.push(Math.floor(key / stride), top, key % stride, bottom);
        return true;
    };
    for (let y = 0; y < height; y++) {
        const row = y * width, current = new Set<number>();
        let x = 0;
        while (x < width) {
            if (!table[alpha[row + x]]) { x++; continue; }
            const x0 = x;
            do { x++; } while (x < width && table[alpha[row + x]]);
            current.add(x0 * stride + x);
        }
        for (const [key, top] of open) {
            if (current.has(key)) continue;
            open.delete(key);
            if (!close(key, top, y)) return null;
        }
        for (const key of current) if (!open.has(key)) open.set(key, y);
        if (y % rowsPerStep === rowsPerStep - 1) yield;
    }
    for (const [key, top] of open) if (!close(key, top, height)) return null;
    return rects;
}
