// A bitmap remains owned by its layer; accounting never keeps that bitmap alive.
const pending = new WeakSet<ImageBitmap>();
const listeners = new Set<() => void>();
let count = 0;

export function markPdfTileArrived(bitmap: ImageBitmap): void {
    if (pending.has(bitmap)) return;
    pending.add(bitmap); count++;
}
function release(bitmap: ImageBitmap): void {
    if (!pending.delete(bitmap)) return;
    count--;
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* A failed wake must not strand another bitmap's ownership. */ }
    }
}
/** The layer has successfully uploaded or painted these pixels at least once. */
export function consumePdfTileArrival(bitmap: ImageBitmap): void { release(bitmap); }
/** The layer discarded these pixels before they were consumed. */
export function forgetPdfTileArrival(bitmap: ImageBitmap): void { release(bitmap); }
export function pdfTileArrivalCount(): number { return count; }
export function subscribePdfTileArrivals(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Arrived rasters whose every pixel is one colour, with that colour: the raster's own four bytes (RGBA, straight from PDFium), marked
 * by the producer. A GPU tile layer draws such a tile from a 1x1 texture of those bytes (tileLayer's solid tiles), and the audit tapes
 * 'pdf:uniform-replaced' by it. Weak: a closed bitmap's mark goes with it. */
const uniform = new WeakMap<ImageBitmap, Uint8Array>();
export function markPdfTileUniform(bitmap: ImageBitmap, rgba: Uint8Array): void { uniform.set(bitmap, rgba); }
export function isPdfTileUniform(bitmap: ImageBitmap): boolean { return uniform.has(bitmap); }
export function pdfTileUniformColour(bitmap: ImageBitmap): Uint8Array | null { return uniform.get(bitmap) ?? null; }
