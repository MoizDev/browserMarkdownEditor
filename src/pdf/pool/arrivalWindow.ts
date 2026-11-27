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
export function consumePdfTileArrival(bitmap: ImageBitmap): void { release(bitmap); }
export function forgetPdfTileArrival(bitmap: ImageBitmap): void { release(bitmap); }
export function pdfTileArrivalCount(): number { return count; }
export function subscribePdfTileArrivals(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

const uniform = new WeakMap<ImageBitmap, Uint8Array>();
export function markPdfTileUniform(bitmap: ImageBitmap, rgba: Uint8Array): void { uniform.set(bitmap, rgba); }
export function isPdfTileUniform(bitmap: ImageBitmap): boolean { return uniform.has(bitmap); }
export function pdfTileUniformColour(bitmap: ImageBitmap): Uint8Array | null { return uniform.get(bitmap) ?? null; }
