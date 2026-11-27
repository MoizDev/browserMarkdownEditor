import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './PdfRenderNotice.css';

export interface PdfThumbnailsHandle {
    setCurrentPage(index: number): void;
    invalidate(pages: Iterable<number>): void;
}

interface PdfThumbnailsProps {
    sizes: ReadonlyArray<{ width: number; height: number }>;
    renderThumbnail: (index: number, scale: number) => Promise<string>;
    onSelect: (index: number) => void;
    initialPage: number;
    failedPages?: ReadonlySet<number>;
}

/** CSS width of a thumbnail. The strip is this plus its padding — see
 *  --pdf-thumbs-width, which must agree. */
const THUMB_WIDTH = 108;
const LABEL_HEIGHT = 22;
const ROW_GAP = 10;
const PAD = 12;
const OVERSCAN = 3;
const MAX_CACHED = 160;
const NO_FAILED_PAGES: ReadonlySet<number> = new Set();

function PdfThumbnails({ sizes, renderThumbnail, onSelect, initialPage, failedPages = NO_FAILED_PAGES }: PdfThumbnailsProps, ref: React.ForwardedRef<PdfThumbnailsHandle>) {
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
    const knownFailures = useRef(failedPages);
    useLayoutEffect(() => {
        knownFailures.current = failedPages;
        for (const i of failedPages) {
            const url = urlsRef.current.get(i);
            if (url) { URL.revokeObjectURL(url); urlsRef.current.delete(i); }
        }
    }, [failedPages]);
    const staleRef = useRef<Set<number>>(new Set());
    const staleGenRef = useRef<Map<number, number>>(new Map());
    const aliveRef = useRef(true);
    const pumpingRef = useRef(false);
    const renderRef = useRef(renderThumbnail);
    useEffect(() => { renderRef.current = renderThumbnail; }, [renderThumbnail]);

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
            staleRef.current.delete(i);
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
                    if ((urlsRef.current.has(i) && !staleRef.current.has(i)) || failedRef.current.has(i) || knownFailures.current.has(i)) continue;
                    if (Math.abs(i - mid) < best) { best = Math.abs(i - mid); next = i; }
                }
                if (next < 0) return;
                const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
                const generation = staleGenRef.current.get(next) ?? 0;
                try {
                    const url = await renderRef.current(next, (THUMB_WIDTH * dpr) / (sizes[next].width || 1));
                    if (!aliveRef.current) { URL.revokeObjectURL(url); return; }
                    if (knownFailures.current.has(next)) { URL.revokeObjectURL(url); continue; }
                    const old = urlsRef.current.get(next);
                    if (old) URL.revokeObjectURL(old);
                    urlsRef.current.set(next, url);
                    if ((staleGenRef.current.get(next) ?? 0) === generation) staleRef.current.delete(next);
                    evict();
                    setVersion(v => v + 1);
                } catch (err) {
                    failedRef.current.add(next);
                    if (aliveRef.current) {
                        console.warn(`Could not render the thumbnail for page ${next + 1}:`, err);
                        setVersion(v => v + 1);
                    }
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
        invalidate(pages: Iterable<number>) {
            for (const i of pages) {
                failedRef.current.delete(i);
                staleRef.current.add(i);
                staleGenRef.current.set(i, (staleGenRef.current.get(i) ?? 0) + 1);
            }
            void pump();
        },
    }), [clampPage, reveal, pump]);

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
                    const failed = failedPages.has(i) || failedRef.current.has(i);
                    return (
                        <button
                            key={i}
                            type="button"
                            className={`pdf-thumb${i === current ? ' is-current' : ''}`}
                            style={{ top: geometry.tops[i], width: THUMB_WIDTH }}
                            onClick={() => onSelect(i)}
                            aria-label={`Page ${i + 1}${failed ? ' — thumbnail unavailable' : ''}`}
                            aria-current={i === current ? 'page' : undefined}
                        >
                            <span className="pdf-thumb-page" style={{ height: geometry.imageHeights[i] }}>
                                {failed ? <span className="pdf-thumb-failure">Thumbnail unavailable</span> : url && <img src={url} alt="" draggable={false} />}
                            </span>
                            <span className="pdf-thumb-label">{i + 1}</span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}

export function ThumbnailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            className={`pdf-viewer-thumbs-toggle${open ? ' is-on' : ''}`}
            onClick={onToggle}
            data-tooltip={open ? 'Hide page thumbnails' : 'Show page thumbnails'}
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
