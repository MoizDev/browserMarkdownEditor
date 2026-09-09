// How thick the pen is, app-wide.
//
// AN EXTERNAL STORE, not a prop and not per-file, for the same reason
// `saveEpoch` is one: the value is read by a panel inside every canvas, and two
// canvases can be on screen at once in a split — a per-pane copy would let the
// two drift apart while both claimed to be "the pen". One value, one
// subscription, persisted like the rest of the appearance settings.
//
// WHY A NUMBER AND NOT A SIZE. tldraw's thickness is the four-step `size` style
// (s/m/l/xl), and its thinnest, `s`, is still 3px of ink — too heavy for small
// handwriting on a ruled page. A draw shape also carries `props.scale`, which
// multiplies that width, so pinning `size` to `s` and varying `scale`
// continuously gives a real range that reaches far below tldraw's floor:
//
//     rendered width = (2 * STROKE_SIZES[size] + 1) * scale
//                    = 3 * scale                          (at size 's')
//
// `scale` is an ordinary shape prop, so it is saved in the file, survives a
// reopen, and rides the vector export as a uniform transform — nothing about
// this is a display-only trick.

const STORAGE_KEY = 'penScale';

/** Thinnest the slider goes: 3 * 0.12 ≈ 0.36px of ink, about as fine as a
 *  0.3mm technical pen and still visible at 100%. */
export const MIN_PEN_SCALE = 0.12;

/** Thickest: 3 * 3.5 ≈ 10.5px, which is tldraw's own XL. Going thin is what was
 *  asked for, but a pen that could no longer be thick would be a loss. */
export const MAX_PEN_SCALE = 3.5;

/** tldraw's `size: 's'` at scale 1 — the width the app opens with, and the
 *  reference the slider is calibrated around. */
export const DEFAULT_PEN_SCALE = 1;

function clamp(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_PEN_SCALE;
    return Math.min(MAX_PEN_SCALE, Math.max(MIN_PEN_SCALE, value));
}

let scale = clamp(Number(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_PEN_SCALE));
const listeners = new Set<() => void>();

export function getPenScale(): number {
    return scale;
}

export function setPenScale(next: number): void {
    const clamped = clamp(next);
    if (clamped === scale) return;
    scale = clamped;
    try {
        localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch (err) {
        // A full or blocked localStorage must not stop the pen changing width;
        // it only costs the setting across a reload.
        console.warn('Could not save the pen width:', err);
    }
    for (const listener of listeners) listener();
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribePenScale(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * The slider position for a width, and back.
 *
 * Logarithmic, because the interesting range is bunched at the thin end: half
 * the travel covers 0.12→1 (everything finer than tldraw's `s`) and half covers
 * 1→3.5. A linear slider would spend 70% of its length on widths nobody writes
 * with and make the fine end impossible to hit.
 */
export function penScaleToSlider(value: number): number {
    const span = Math.log(MAX_PEN_SCALE) - Math.log(MIN_PEN_SCALE);
    return (Math.log(clamp(value)) - Math.log(MIN_PEN_SCALE)) / span;
}

export function sliderToPenScale(position: number): number {
    const span = Math.log(MAX_PEN_SCALE) - Math.log(MIN_PEN_SCALE);
    return clamp(Math.exp(Math.log(MIN_PEN_SCALE) + position * span));
}
