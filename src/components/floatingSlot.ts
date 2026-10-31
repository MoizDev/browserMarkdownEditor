// A pane that floats OVER the column its document occupies, rather than living
// inside it — the shape PDFs, whiteboards and notebooks all need.
//
// WHY ANY OF THEM FLOAT. A pane that lives in the slot exists only while its
// tab is shown, so a tab switch UNMOUNTS it and coming back rebuilds the
// document from scratch. For a canvas that means re-parsing the file, standing
// a fresh tldraw editor up and re-decoding every picture on the board; measured
// on a production build with a 1,200-shape board carrying 12 screenshots, each
// return cost 150-250ms with the main thread blocked for most of it — and the
// reading position, the selection and the undo history went with it. Floating
// the pane and merely HIDING it off screen costs nothing per switch and keeps
// all three.
//
// Two hooks, because the hazards are not obvious and were each paid for once.

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * The inline left/width that stands this pane over its column.
 *
 * ON SCREEN it is expressed as the editor's own CSS variables, so a divider
 * drag carries the pane along with its column in the very write that moves the
 * column — no render, and never a frame out of step with it.
 *
 * HIDDEN it freezes to the numbers instead, and to the geometry it was last
 * SHOWN at: those variables describe the columns as they are now, so a hidden
 * pane left reading them would be dragged around behind an arrangement it is
 * not even in. Nor may it snap back to full width when its tab goes to the
 * back — that resizes the pane, which trips a viewer's ResizeObserver into
 * re-fitting and re-rasterizing a document nobody can see. (Measured: a
 * half-width pane at 618px jumping to 1236px on every switch.)
 *
 * It is the resolved GEOMETRY that is retained, not the slot index and pane
 * count it used to be derived from: those two no longer determine a width now
 * that the columns can be sized individually. Every drag commits before any tab
 * switch can happen, so the frozen numbers are never mid-gesture.
 */
export function useFloatingSlot(isVisible: boolean, index: number, left: number, width: number): CSSProperties {
    const [shown, setShown] = useState({ index, left, width });
    useEffect(() => {
        if (isVisible) setShown(prev =>
            prev.index === index && prev.left === left && prev.width === width
                ? prev
                : { index, left, width });
    }, [isVisible, index, left, width]);
    const slot = isVisible ? { index, left, width } : shown;
    return useMemo(() => (isVisible
        ? {
            left: `calc(var(--pane-x-${slot.index}) * 1%)`,
            width: `calc(var(--pane-w-${slot.index}) * 1%)`,
            right: 'auto' as const,
        }
        : { left: `${slot.left}%`, width: `${slot.width}%`, right: 'auto' as const }
    ), [isVisible, slot.index, slot.left, slot.width]);
}

/**
 * Has this pane ever been on screen?
 *
 * Panes for background tabs mount hidden at session restore, and the work
 * behind them is heavy — reading the file, pdf.js, the tldraw chunk and an
 * editor per board. A vault reopened on five canvases must pay for the one the
 * reader is looking at, not all five; after that the pane stays built, which is
 * the whole point of floating it.
 */
export function useActivated(isVisible: boolean): boolean {
    const [activated, setActivated] = useState(isVisible);
    useEffect(() => { if (isVisible) setActivated(true); }, [isVisible]);
    return activated;
}
