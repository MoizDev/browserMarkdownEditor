export interface AlphaMask {
    readonly width: number;
    readonly height: number;
    readonly alpha: Uint8Array | Uint8ClampedArray;
}

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
