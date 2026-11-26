import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Where a bar floats from: the centre of an item's top edge, and its bottom edge, in the bar's offset parent's pixels. */
export interface FloatingAnchor { readonly x: number; readonly top: number; readonly bottom: number }
interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Clear of the pane's edges and of the chrome, by this much; and this far from the item it belongs to. */
const MARGIN = 8, GAP = 10;
/** The board's own chrome a bar over the canvas must never cover: the header and page controls, the docked Styles panel, the
 * tool strip, the zoom box, the minimap and the notices. */
const CHROME = ['.board-chrome-header', '.board-chrome-top > :not(.board-chrome-header)', '.board-style-panel', '.board-chrome-tools',
    '.board-chrome-zoom', '.native-minimap', '.board-viewer-notice'].join(', ');

const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The crop bar and the picture toolbar float above their picture, centred on it, wherever the picture is; near the pane's
 * right edge they covered the Styles panel and ran past the pane (measured, 1200 px window: the crop bar from x 926 to 1235
 * over a panel at 1008-1192, its Apply button cut off), and under a picture near the top they sat on the header. They now go
 * above the picture when that is clear, else below it, else just under whatever chrome is above; and sideways only as far as
 * clears the chrome, nearest the picture's centre first.
 */
export function placeFloatingBar(anchor: FloatingAnchor, size: { readonly w: number; readonly h: number },
    area: { readonly w: number; readonly h: number }, chrome: readonly Box[]): { readonly x: number; readonly y: number } {
    const { w, h } = size;
    const minX = MARGIN, maxX = Math.max(MARGIN, area.w - MARGIN - w), minY = MARGIN, maxY = Math.max(MARGIN, area.h - MARGIN - h);
    const clampX = (x: number) => Math.min(maxX, Math.max(minX, x)), clampY = (y: number) => Math.min(maxY, Math.max(minY, y));
    const centre = clampX(anchor.x - w / 2), above = anchor.top - GAP - h, below = anchor.bottom + GAP;
    const ys = [above, below].filter(y => y >= minY && y <= maxY);
    const further = [...chrome.map(box => box.y + box.h + MARGIN), ...chrome.map(box => box.y - MARGIN - h), clampY(above)].map(clampY)
        .sort((a, b) => Math.abs(a - above) - Math.abs(b - above));
    for (const y of [...ys, ...further]) {
        const row = chrome.filter(box => y < box.y + box.h && box.y < y + h);
        const xs = [centre, ...row.flatMap(box => [box.x - MARGIN - w, box.x + box.w + MARGIN])].map(clampX)
            .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
        const x = xs.find(candidate => !row.some(box => meets({ x: candidate, y, w, h }, box)));
        if (x !== undefined) return { x, y };
    }
    // Nothing is clear (a pane narrower than the bar): it stays on the picture, inside the pane.
    return { x: centre, y: clampY(above) };
}

/** Keeps `ref`'s bar placed by `placeFloatingBar` while it is shown, following the item and the chrome as either moves. Checked
 * each frame while shown: the Styles panel opens and folds, notices come and go and the camera moves, none of which re-renders
 * the bar. Only while shown: every board pane mounts a picture toolbar, and run from mount it kept a frame callback going 60
 * times a second on every board, idle, hidden or with no picture on it (measured: 60 rAF/s on an idle board, 0 before). */
export function useFloatingBar(ref: RefObject<HTMLElement | null>, anchor: FloatingAnchor | null): void {
    const latest = useRef(anchor);
    useLayoutEffect(() => { latest.current = anchor; });
    const shown = anchor !== null;
    useLayoutEffect(() => {
        if (!shown) return;
        let raf = 0, last = '';
        const place = () => {
            const bar = ref.current, at = latest.current, parent = bar?.offsetParent;
            if (bar && at && parent instanceof HTMLElement) {
                const origin = parent.getBoundingClientRect();
                const chrome: Box[] = [];
                for (const element of parent.querySelectorAll(CHROME)) {
                    if (element === bar || bar.contains(element)) continue;
                    const r = element.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) chrome.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
                }
                const { x, y } = placeFloatingBar(at, { w: bar.offsetWidth, h: bar.offsetHeight }, { w: parent.clientWidth, h: parent.clientHeight }, chrome);
                const key = `${Math.round(x)},${Math.round(y)}`;
                if (key !== last) { last = key; bar.style.left = `${Math.round(x)}px`; bar.style.top = `${Math.round(y)}px`; }
            }
            raf = requestAnimationFrame(place);
        };
        place();
        return () => cancelAnimationFrame(raf);
    }, [ref, shown]);
}
