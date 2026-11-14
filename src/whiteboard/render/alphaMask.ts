import type { PathCommand } from '../../platform/types';

/** Decoded alpha of one image in source pixels, row-major, one byte per pixel. */
export interface AlphaMask {
    readonly width: number;
    readonly height: number;
    readonly alpha: Uint8Array | Uint8ClampedArray;
}

export interface AlphaMaskCoverage {
    /** Fully opaque (alpha 255) pixels as disjoint same-orientation rectangles in source pixels: nonzero is their exact union. */
    readonly opaque: readonly PathCommand[];
    /** True when any pixel is partially transparent (0 < alpha < 255). Such an image cannot occlude exactly. */
    readonly partial: boolean;
    /** True when any pixel is not fully transparent. */
    readonly any: boolean;
}

const OPAQUE = 255;

/**
 * Traces the opaque pixels of a decoded alpha mask into exact coverage, one row at a time. Each
 * row's runs of alpha 255 are merged with the identical run directly above, so every rectangle is
 * the exact union of its pixels and no two rectangles overlap. The generator yields every
 * `rowsPerStep` rows so a caller can drive it in cooperative slices, or drain it synchronously.
 * It returns null when the trace would exceed `maxCommands`; a caller must then treat the image as
 * translucent, which claims no occlusion, rather than publish a partial outline.
 *
 * Measured design: the output is bounded by the run count, not the pixel count, so a dense photo
 * with few opaque runs stays small while a fully opaque tile collapses to one rectangle per row.
 */
export function* alphaMaskSteps(mask: AlphaMask, maxCommands: number, rowsPerStep = 64): Generator<void, AlphaMaskCoverage | null, void> {
    const { width, height, alpha } = mask;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || alpha.length < width * height) {
        throw new RangeError('Alpha mask dimensions do not match its bytes');
    }
    if (!Number.isInteger(rowsPerStep) || rowsPerStep < 1) throw new RangeError('Alpha mask rowsPerStep must be a positive integer');
    const stride = width + 1, commands: PathCommand[] = [];
    // An open rectangle is keyed by its run (x0, x1) and remembers the first row it covers.
    const open = new Map<number, number>();
    let partial = false, any = false;
    const emit = (key: number, top: number, bottom: number): boolean => {
        const x0 = Math.floor(key / stride), x1 = key % stride;
        if (commands.length + 5 > maxCommands) return false;
        commands.push(['M', x0, top], ['L', x1, top], ['L', x1, bottom], ['L', x0, bottom], ['Z']);
        return true;
    };
    for (let y = 0; y < height; y++) {
        const row = y * width, current = new Set<number>();
        let x = 0;
        while (x < width) {
            const a = alpha[row + x];
            if (a === OPAQUE) {
                const x0 = x;
                do { x++; } while (x < width && alpha[row + x] === OPAQUE);
                current.add(x0 * stride + x);
                any = true;
                continue;
            }
            if (a !== 0) { any = true; partial = true; }
            x++;
        }
        for (const [key, top] of open) {
            if (current.has(key)) continue;
            open.delete(key);
            if (!emit(key, top, y)) return null;
        }
        for (const key of current) if (!open.has(key)) open.set(key, y);
        if (y % rowsPerStep === rowsPerStep - 1) yield;
    }
    for (const [key, top] of open) if (!emit(key, top, height)) return null;
    return Object.freeze({ opaque: Object.freeze(commands), partial, any });
}

/** Drains the steps synchronously, for a caller that has already bounded the mask's size. */
export function alphaMaskCoverage(mask: AlphaMask, maxCommands: number): AlphaMaskCoverage | null {
    const steps = alphaMaskSteps(mask, maxCommands);
    for (;;) {
        const next = steps.next();
        if (next.done) return next.value;
    }
}
