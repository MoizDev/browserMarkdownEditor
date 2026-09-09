// How thick the pen is — PER OPEN CANVAS, remembered per file.
//
// Keyed on the live editor rather than held as one app-wide value, because a
// split can show two canvases at once and each answers to its own file: the
// width belongs to the document you are writing in, not to the app. The panel
// inside a canvas reads its own editor's entry; the pane that owns that editor
// writes the value into the file's `ui` block and hands it back on reopen.
//
// A WeakMap, so a closed canvas's entry goes when its editor does — there is no
// unmount hook that could be trusted to run for every editor that ever existed.
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

import type { Editor } from 'tldraw';

/** Remembers the last width used anywhere, so a file that has never been drawn
 *  in opens at the width you were last working at rather than at the default. */
const LAST_USED_KEY = 'penScale';

/** Thinnest the slider goes: 3 * 0.12 ≈ 0.36px of ink, about as fine as a
 *  0.3mm technical pen and still visible at 100%. */
export const MIN_PEN_SCALE = 0.12;

/** Thickest: 3 * 3.5 ≈ 10.5px, which is tldraw's own XL. Going thin is what was
 *  asked for, but a pen that could no longer be thick would be a loss. */
export const MAX_PEN_SCALE = 3.5;

/** tldraw's `size: 's'` at scale 1 — the reference the slider is calibrated
 *  around, and the width used when nothing else is known. */
export const DEFAULT_PEN_SCALE = 1;

export function clampPenScale(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_PEN_SCALE;
    return Math.min(MAX_PEN_SCALE, Math.max(MIN_PEN_SCALE, value));
}

const scales = new WeakMap<Editor, number>();
const listeners = new Set<() => void>();

/** The width the last canvas to be adjusted was set to, across sessions. */
function lastUsed(): number {
    try {
        const stored = localStorage.getItem(LAST_USED_KEY);
        return stored === null ? DEFAULT_PEN_SCALE : clampPenScale(Number(stored));
    } catch {
        // A blocked localStorage costs the memory, not the pen.
        return DEFAULT_PEN_SCALE;
    }
}

/**
 * Seed a canvas's width, from the file if it recorded one.
 *
 * Called before the panel first renders, so the slider never shows a width the
 * canvas is not actually drawing at. A file with nothing recorded inherits the
 * width you were last using, which is friendlier than snapping every new
 * notebook back to the default.
 */
export function seedPenScale(editor: Editor, saved: number | undefined): void {
    scales.set(editor, saved === undefined ? lastUsed() : clampPenScale(saved));
    for (const listener of listeners) listener();
}

export function getPenScale(editor: Editor): number {
    return scales.get(editor) ?? DEFAULT_PEN_SCALE;
}

export function setPenScale(editor: Editor, next: number): void {
    const clamped = clampPenScale(next);
    if (clamped === scales.get(editor)) return;
    scales.set(editor, clamped);
    try {
        localStorage.setItem(LAST_USED_KEY, String(clamped));
    } catch (err) {
        console.warn('Could not remember the pen width for new files:', err);
    }
    for (const listener of listeners) listener();
}

/** `useSyncExternalStore`'s subscribe half. One notification for every canvas —
 *  there are at most a handful on screen, and each reads only its own entry. */
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
    return (Math.log(clampPenScale(value)) - Math.log(MIN_PEN_SCALE)) / span;
}

export function sliderToPenScale(position: number): number {
    const span = Math.log(MAX_PEN_SCALE) - Math.log(MIN_PEN_SCALE);
    return clampPenScale(Math.exp(Math.log(MIN_PEN_SCALE) + position * span));
}
