// Scrolling a stack of pages on a tldraw canvas like a document, not a board.
//
// Shared by the two canvases that are a column of pages rather than an open
// whiteboard, the PDF annotator and ruled notebooks, so they cannot drift apart.
//
// tldraw's canvas is infinite: a two-finger swipe pans on both axes, and a page
// can be carried clean off screen. A stack of pages wants what a PDF reader
// gives instead: vertical scrolling only, full width meaning the page's real
// edges touching the screen's, and zoom past that when you want it.

import { react, type Editor } from 'tldraw';

export interface PageBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Air above and below the stack, and above a page the view is put at. None at
 *  the sides: at full width a page runs edge to edge. A canvas with chrome
 *  floating over its top edge (a notebook's paper toolbar) passes a wider one. */
export const PAGE_TOP_GUTTER = 16;

/** The camera that puts `box` at the top of the view, centred, at zoom `z`. */
export function cameraFor(box: PageBox, screenWidth: number, z: number, offset = 0, gutter = PAGE_TOP_GUTTER) {
    return {
        x: screenWidth / (2 * z) - (box.x + box.width / 2),
        // Mid-page, the top edge goes back exactly where it was left; at the
        // start of a page it gets a little air.
        y: (offset > 0 ? 0 : gutter / z) - (box.y + offset * box.height),
        z,
    };
}

/** First page whose bottom edge is below `y`. A gap between pages counts as the
 *  page after it, as it does in the PDF reader. */
export function pageAt(boxes: readonly PageBox[], y: number): number {
    let lo = 0;
    let hi = boxes.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (boxes[mid].y + boxes[mid].height <= y) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** The zoom at which the widest page exactly fills the view's width. */
export function fitWidthZoom(editor: Editor, boxes: readonly PageBox[]): number {
    const widest = Math.max(1, ...boxes.map(b => b.x + b.width));
    return Math.max(0.05, editor.getViewportScreenBounds().width / widest);
}

export interface PageLock {
    /** Re-bound the camera to a stack that gained, lost or reshaped pages. */
    setPages(boxes: readonly PageBox[]): void;
    dispose(): void;
}

/**
 * Hold the camera to the page stack, and make swipes scroll it vertically.
 *
 * Camera constraints with `contain`: below full width the stack is pinned,
 * centred; above it the camera is clamped to the pages' real edges, so full
 * width is edge to edge and zooming further simply goes further in. No
 * horizontal padding, which is what makes the fit exact.
 *
 * Swipes are caught in the CAPTURE phase on `wrap`, an ancestor of tldraw's own
 * wheel handler, so tldraw never sees one: only `deltaY` is applied. A pinch
 * arrives as a ctrl+wheel and passes straight through to tldraw's zoom.
 */
export function lockCameraToPages(
    editor: Editor,
    wrap: HTMLElement | null,
    boxes: readonly PageBox[],
    gutter = PAGE_TOP_GUTTER,
): PageLock {
    const constrain = (next: readonly PageBox[]) => {
        if (next.length === 0) return;
        const last = next[next.length - 1];
        editor.setCameraOptions({
            constraints: {
                bounds: { x: 0, y: 0, w: Math.max(...next.map(b => b.x + b.width)), h: last.y + last.height },
                padding: { x: 0, y: gutter },
                origin: { x: 0.5, y: 0 },
                initialZoom: 'fit-x',
                baseZoom: 'fit-x',
                behavior: 'contain',
            },
        });
    };
    constrain(boxes);

    const onWheel = (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) return;
        // A long tldraw menu scrolls itself.
        if ((e.target as Element | null)?.closest?.('.tlui-menu, .tlui-popover__content')) return;
        e.preventDefault();
        e.stopPropagation();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? editor.getViewportScreenBounds().height : 1;
        const { x, y, z } = editor.getCamera();
        editor.setCamera({ x, y: y - (e.deltaY * unit) / z, z });
    };
    wrap?.addEventListener('wheel', onWheel, { capture: true, passive: false });

    return {
        setPages: constrain,
        dispose: () => wrap?.removeEventListener('wheel', onWheel, { capture: true }),
    };
}

export interface PageView {
    /** The page under the top edge: what a reading position is recorded against. */
    top: number;
    /** How far into that page the top edge sits, as a fraction of its height. */
    offset: number;
    /** The page to SHOW in a page box: the top one, except once the view is held
     *  against the end of a stack taller than it, where the last pages can never
     *  reach the top and typing the last page number would read back an earlier
     *  one. The PDF reader's rule. */
    shown: number;
}

/**
 * Report which page the view is on, whenever the view moves.
 *
 * A tldraw `react()` reading only the viewport's page bounds, so it runs on a
 * pan, a zoom or a resize and NOT on every pointer move while drawing, which is
 * what a session-scope store listener fires on. At most once per frame.
 * `getBoxes` is read each time, so a stack that grows is followed.
 */
export function watchPageView(
    editor: Editor,
    getBoxes: () => readonly PageBox[],
    onView: (view: PageView) => void,
    gutter = PAGE_TOP_GUTTER,
): () => void {
    let frame = 0;
    const stop = react('paged canvas view', () => {
        editor.getViewportPageBounds();
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            const boxes = getBoxes();
            if (boxes.length === 0) return;
            const view = editor.getViewportPageBounds();
            const top = pageAt(boxes, view.minY);
            const last = boxes[boxes.length - 1];
            const bottom = last.y + last.height;
            // Shown is judged just under the gutter, not at the very top edge. A
            // page the view is put at sits `gutter` below that edge, and when the
            // gutter is wider than the gap between pages (a notebook's toolbar
            // gutter, or any gutter once zoomed well out) the edge itself falls
            // inside the page above: measured, jumping to page 3 read back "2".
            const probe = view.minY + gutter / editor.getZoomLevel();
            const shown = view.maxY >= bottom && view.height < bottom ? pageAt(boxes, view.maxY - 1) : pageAt(boxes, probe);
            const box = boxes[top];
            onView({ top, offset: Math.min(1, Math.max(0, (view.minY - box.y) / box.height)), shown });
        });
    });
    return () => {
        stop();
        cancelAnimationFrame(frame);
    };
}
