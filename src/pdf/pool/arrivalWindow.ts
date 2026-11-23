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

/** Audit only: arrived rasters whose every pixel is one colour, marked by the producer while the render audit is on and never
 * otherwise (tileLayer's 'pdf:uniform-replaced'). Weak: a closed bitmap's mark goes with it. */
const uniform = new WeakSet<ImageBitmap>();
export function markPdfTileUniform(bitmap: ImageBitmap): void { uniform.add(bitmap); }
export function isPdfTileUniform(bitmap: ImageBitmap): boolean { return uniform.has(bitmap); }
