// The pen's streamline, as a store, so a dev panel can move it while you draw.
//
// A store rather than a constant because the whole point of the number is that
// it has to be FELT: 0.64 and 0.4 are indistinguishable on paper and obvious on
// a tablet. Shipping is still a constant — PEN_STREAMLINE is what production
// uses, and the panel that writes this is dev-only (see components/PenDevPanel).
//
// Changing it affects the NEXT stroke; ink already on the canvas keeps the
// value it was drawn with, which is what lets one canvas hold a row of strokes
// at different settings for comparison.

/**
 * What the pen ships with.
 *
 * Effectively no smoothing: ink goes where the pen went. Chosen by drawing with
 * it rather than by reasoning about it — the panel this store exists for was
 * built precisely because the difference between 0.64, 0.4 and 0.01 is
 * invisible in a diff and unmistakable on a tablet, and a graphics tablet
 * reports finely enough that there is no jitter left for smoothing to hide.
 *
 * See components/tightDrawShape.tsx for what the number does and what it cost
 * to reach it.
 */
export const PEN_STREAMLINE = 0.01;

/** tldraw's own value for a solid stroke, kept here as the thing to compare
 *  against — the panel offers it as a preset so "is this better than stock"
 *  is one click rather than a rebuild. */
export const TLDRAW_STREAMLINE = 0.64;

let current = PEN_STREAMLINE;
const listeners = new Set<() => void>();

export function getPenStreamline(): number {
    return current;
}

export function setPenStreamline(value: number): void {
    const next = Math.min(0.95, Math.max(0, value));
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
}

export function subscribePenStreamline(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
