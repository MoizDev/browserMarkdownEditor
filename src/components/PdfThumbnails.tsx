// Page thumbnails: a narrow strip down the left edge of a PDF, shared by the
// reader (PdfViewer) and the annotate canvas.
//
// Built so a 1,000-page document costs what a 10-page one does:
//
//  · WINDOWED. Only the rows in view, plus OVERSCAN either side, exist in the
//    DOM. Every row's height follows from its page's aspect ratio, so the
//    strip's scroll height and each row's position are arithmetic, never a
//    layout measurement.
//  · ONE RENDER AT A TIME, nearest the middle of the view first, re-deciding
//    after every render. A row scrolled past before its turn is simply never
//    rendered, instead of a queue of hundreds of stale requests working through
//    the same pdf.js worker the page you are reading needs.
//  · JPEG OBJECT URLS, CAPPED. A thumbnail is a few KB as a JPEG and ~250KB as
//    a live canvas bitmap; past MAX_CACHED the rows farthest from view are let
//    go and simply re-rendered if you scroll back.
//  · THE CURRENT PAGE ARRIVES THROUGH A HANDLE, NOT A PROP. Scrolling the
//    document re-renders this strip — two dozen rows — and never the host: the
//    reader keeps its page number out of React state for exactly this reason,
//    since re-rendering it means re-rendering every page div.
//
// Keyed by its host on the document, so `sizes` and `renderThumbnail` are fixed
// for the life of one strip and a reloaded document gets a fresh cache.

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface PdfThumbnailsHandle {
    /** Mark `index` as the page on screen and bring its row into view. */
    setCurrentPage(index: number): void;
}

interface PdfThumbnailsProps {
    /** Every page's size at scale 1. Only the aspect ratio matters here. */
    sizes: ReadonlyArray<{ width: number; height: number }>;
    /** Rasterize page `index` (0-based) at `scale` to an object URL, which the
     *  strip then owns and revokes. */
    renderThumbnail: (index: number, scale: number) => Promise<string>;
    onSelect: (index: number) => void;
    initialPage: number;
}

/** CSS width of a thumbnail. The strip is this plus its padding — see
 *  --pdf-thumbs-width, which must agree. */
const THUMB_WIDTH = 108;
const LABEL_HEIGHT = 22;
const ROW_GAP = 10;
const PAD = 12;
const OVERSCAN = 3;
const MAX_CACHED = 160;

function PdfThumbnails({ sizes, renderThumbnail, onSelect, initialPage }: PdfThumbnailsProps, ref: React.ForwardedRef<PdfThumbnailsHandle>) {
    const n = sizes.length;
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const geometry = useMemo(() => {
        const imageHeights: number[] = [];
        const tops: number[] = [];
        let y = PAD;
        for (const size of sizes) {
            const h = Math.round(THUMB_WIDTH * (size.height / (size.width || 1)));
            imageHeights.push(h);
            tops.push(y);
            y += h + LABEL_HEIGHT + ROW_GAP;
        }
        return { imageHeights, tops, total: y - ROW_GAP + PAD };
    }, [sizes]);

    const clampPage = useCallback((i: number) => Math.min(n - 1, Math.max(0, i)), [n]);
    const [current, setCurrent] = useState(() => clampPage(initialPage));
    const currentRef = useRef(current);
    const [range, setRange] = useState({ from: 0, to: Math.min(n - 1, 8) });
    const rangeRef = useRef(range);
    const [, setVersion] = useState(0);

    const urlsRef = useRef<Map<number, string>>(new Map());
    const failedRef = useRef<Set<number>>(new Set());
    const aliveRef = useRef(true);
    const pumpingRef = useRef(false);
    const renderRef = useRef(renderThumbnail);
    useEffect(() => { renderRef.current = renderThumbnail; }, [renderThumbnail]);

    /** First row whose bottom edge is below `y`. */
    const rowAt = useCallback((y: number) => {
        const { tops, imageHeights } = geometry;
        let lo = 0, hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tops[mid] + imageHeights[mid] + LABEL_HEIGHT < y) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }, [geometry, n]);

    const evict = useCallback(() => {
        const urls = urlsRef.current;
        if (urls.size <= MAX_CACHED) return;
        const { from, to } = rangeRef.current;
        const mid = (from + to) / 2;
        const farthest = [...urls.keys()].sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid));
        for (const i of farthest.slice(0, urls.size - MAX_CACHED)) {
            URL.revokeObjectURL(urls.get(i)!);
            urls.delete(i);
        }
    }, []);

    const pump = useCallback(async () => {
        if (pumpingRef.current) return;
        pumpingRef.current = true;
        try {
            for (;;) {
                if (!aliveRef.current) return;
                const { from, to } = rangeRef.current;
                const mid = (from + to) / 2;
                let next = -1;
                for (let i = Math.max(0, from - OVERSCAN), best = Infinity; i <= Math.min(n - 1, to + OVERSCAN); i++) {
                    if (urlsRef.current.has(i) || failedRef.current.has(i)) continue;
                    if (Math.abs(i - mid) < best) { best = Math.abs(i - mid); next = i; }
                }
                if (next < 0) return;
                const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
                try {
                    const url = await renderRef.current(next, (THUMB_WIDTH * dpr) / (sizes[next].width || 1));
                    if (!aliveRef.current) { URL.revokeObjectURL(url); return; }
                    urlsRef.current.set(next, url);
                    evict();
                    setVersion(v => v + 1);
                } catch (err) {
                    // A page that will not rasterize keeps its blank frame rather
                    // than being retried on every scroll.
                    failedRef.current.add(next);
                    if (aliveRef.current) console.warn(`Could not render the thumbnail for page ${next + 1}:`, err);
                }
            }
        } finally {
            pumpingRef.current = false;
        }
    }, [n, sizes, evict]);

    const measure = useCallback(() => {
        const el = scrollRef.current;
        if (!el || n === 0) return;
        const from = rowAt(el.scrollTop);
        const to = Math.min(n - 1, rowAt(el.scrollTop + el.clientHeight));
        if (from !== rangeRef.current.from || to !== rangeRef.current.to) {
            rangeRef.current = { from, to };
            setRange({ from, to });
        }
        void pump();
    }, [n, rowAt, pump]);

    const frameRef = useRef(0);
    const onScroll = useCallback(() => {
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(() => { frameRef.current = 0; measure(); });
    }, [measure]);

    /** Scroll the strip just enough to show row `i`, if it is not already shown. */
    const reveal = useCallback((i: number) => {
        const el = scrollRef.current;
        if (!el) return;
        const top = geometry.tops[i];
        const bottom = top + geometry.imageHeights[i] + LABEL_HEIGHT;
        if (top < el.scrollTop) el.scrollTop = top - PAD;
        else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + PAD;
    }, [geometry]);

    useImperativeHandle(ref, () => ({
        setCurrentPage(index: number) {
            const i = clampPage(index);
            if (i === currentRef.current) return;
            currentRef.current = i;
            setCurrent(i);
            reveal(i);
        },
    }), [clampPage, reveal]);

    // Open on the page being read, then keep the visible range true as the
    // strip itself is resized (a window resize, a split being dragged).
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const i = currentRef.current;
        el.scrollTop = Math.max(0, geometry.tops[i] - el.clientHeight / 2 + geometry.imageHeights[i] / 2);
        measure();
        const observer = new ResizeObserver(() => measure());
        observer.observe(el);
        return () => observer.disconnect();
    }, [geometry, measure]);

    useEffect(() => {
        aliveRef.current = true;
        const urls = urlsRef.current;
        return () => {
            aliveRef.current = false;
            cancelAnimationFrame(frameRef.current);
            for (const url of urls.values()) URL.revokeObjectURL(url);
            urls.clear();
        };
    }, []);

    const rows: number[] = [];
    for (let i = Math.max(0, range.from - OVERSCAN); i <= Math.min(n - 1, range.to + OVERSCAN); i++) rows.push(i);

    return (
        <nav className="pdf-thumbs" ref={scrollRef} onScroll={onScroll} aria-label="Pages">
            <div className="pdf-thumbs-inner" style={{ height: geometry.total }}>
                {rows.map(i => {
                    const url = urlsRef.current.get(i);
                    return (
                        <button
                            key={i}
                            type="button"
                            className={`pdf-thumb${i === current ? ' is-current' : ''}`}
                            style={{ top: geometry.tops[i], width: THUMB_WIDTH }}
                            onClick={() => onSelect(i)}
                            aria-label={`Page ${i + 1}`}
                            aria-current={i === current ? 'page' : undefined}
                        >
                            <span className="pdf-thumb-page" style={{ height: geometry.imageHeights[i] }}>
                                {url && <img src={url} alt="" draggable={false} />}
                            </span>
                            <span className="pdf-thumb-label">{i + 1}</span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}

/** The button that opens and closes the strip — one component so the reader
 *  and the annotate canvas cannot drift apart. */
export function ThumbnailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            className={`pdf-viewer-thumbs-toggle${open ? ' is-on' : ''}`}
            onClick={onToggle}
            title={open ? 'Hide page thumbnails' : 'Show page thumbnails'}
            aria-label="Page thumbnails"
            aria-pressed={open}
        >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
            </svg>
        </button>
    );
}

export default memo(forwardRef(PdfThumbnails));
