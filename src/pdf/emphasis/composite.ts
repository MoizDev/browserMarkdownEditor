export interface EmphasisPoint { x: number; y: number }
export type EmphasisCell = readonly [EmphasisPoint, EmphasisPoint, EmphasisPoint, EmphasisPoint];
export interface EmphasisRegion {
    /** Global device-pixel origin, including any apron. */
    x: number;
    y: number;
    width: number;
    height: number;
    /** Page point (0, 0) in global device pixels, and pixels per page point. */
    pageX: number;
    pageY: number;
    scale: number;
}

/** Copy full-composition ON pixels only at covered global pixel centres; OFF is never mutated. */
export function compositeEmphasis(off: Uint8Array | Uint8ClampedArray, on: Uint8Array | Uint8ClampedArray,
    cells: readonly EmphasisCell[], region: EmphasisRegion): { pixels: Uint8Array; changedPixels: number } {
    const { x, y, width, height, pageX, pageY, scale } = region;
    if (![x, y, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0 ||
        width * height > 1_048_576 || ![pageX, pageY, scale].every(Number.isFinite) || scale <= 0 ||
        off.length !== width * height * 4 || on.length !== off.length) throw new RangeError('Invalid emphasis raster');
    const mask = new Uint8Array(width * height);
    let coverageWork = 0;
    for (const cell of cells) {
        const points = cell.map(p => ({ x: pageX + p.x * scale, y: pageY + p.y * scale }));
        if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new RangeError('Invalid emphasis cell');
        const area = points.reduce((sum, point, i) => {
            const next = points[(i + 1) % 4];
            return sum + (point.x - points[0].x) * (next.y - points[0].y) - (next.x - points[0].x) * (point.y - points[0].y);
        }, 0);
        if (!Number.isFinite(area) || area === 0) throw new RangeError('Degenerate emphasis cell');
        const left = Math.max(x, Math.ceil(Math.min(...points.map(p => p.x)) - 0.5));
        const right = Math.min(x + width - 1, Math.floor(Math.max(...points.map(p => p.x)) - 0.5));
        const top = Math.max(y, Math.ceil(Math.min(...points.map(p => p.y)) - 0.5));
        const bottom = Math.min(y + height - 1, Math.floor(Math.max(...points.map(p => p.y)) - 0.5));
        coverageWork += Math.max(0, right - left + 1) * Math.max(0, bottom - top + 1);
        if (coverageWork > width * height * 32 + 1_000_000) throw new RangeError('Emphasis mask exceeds work limit');
        for (let py = top; py <= bottom; py++) for (let px = left; px <= right; px++) {
            let positive = false, negative = false;
            for (let i = 0; i < 4; i++) {
                const a = points[i], b = points[(i + 1) % 4];
                const cross = (b.x - a.x) * (py + 0.5 - a.y) - (b.y - a.y) * (px + 0.5 - a.x);
                positive ||= cross > 0;
                negative ||= cross < 0;
            }
            if (!(positive && negative)) mask[(py - y) * width + px - x] = 1;
        }
    }
    const pixels = new Uint8Array(off);
    let changedPixels = 0;
    for (let i = 0; i < mask.length; i++) {
        const p = i * 4;
        if (off[p + 3] !== 255 || on[p + 3] !== 255) throw new RangeError('Emphasis raster must be opaque');
        if (!mask[i]) continue;
        if (off[p] !== on[p] || off[p + 1] !== on[p + 1] || off[p + 2] !== on[p + 2] || off[p + 3] !== on[p + 3]) changedPixels++;
        pixels[p] = on[p]; pixels[p + 1] = on[p + 1]; pixels[p + 2] = on[p + 2]; pixels[p + 3] = on[p + 3];
    }
    return { pixels, changedPixels };
}
