import { useLayoutEffect, useRef, type RefObject } from 'react';

export interface FloatingAnchor { readonly x: number; readonly top: number; readonly bottom: number }
interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

const MARGIN = 8, GAP = 10;
const CHROME = ['.board-chrome-header', '.board-chrome-top > :not(.board-chrome-header)', '.board-style-panel', '.board-chrome-tools',
    '.board-chrome-zoom', '.native-minimap', '.board-viewer-notice'].join(', ');

const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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
    return { x: centre, y: clampY(above) };
}

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
