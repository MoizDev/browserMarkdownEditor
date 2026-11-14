import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TileEmphasisArgs } from '../pdf/emphasis/types';
import type { PdfPoolDocument } from '../pdf/pool/types';
import { createThumbnailWorkQueue, PdfThumbnailCache } from '../pdf/session/thumbnailCache';
import type { ThumbnailWorkQueue } from '../pdf/session/thumbnailCache';
import { openContextMenu } from '../utils/contextMenu';
import { dismissOnEscape } from '../utils/escapeDismiss';
import './PdfTiledThumbnails.css';

const ROW = 180, OVERSCAN = 2;
interface Props {
    document: PdfPoolDocument;
    isVisible: boolean;
    currentPage: number;
    onPage(page: number): void;
    onNotice(message: string): void;
    getVariant(page: number): TileEmphasisArgs;
    profileKey: string;
}
type Live = Props & { open: boolean };
type WindowRange = { from: number; to: number; middle: number };

function windowPages(range: WindowRange, count: number): number[] {
    const pages: number[] = [];
    for (let page = Math.max(0, range.from - OVERSCAN); page <= Math.min(count - 1, range.to + OVERSCAN); page++) pages.push(page);
    return pages.sort((a, b) => Math.abs(a - range.middle) - Math.abs(b - range.middle) || a - b).slice(0, 10);
}

// This hook returns its chrome nodes; its private components share its lifecycle.
// eslint-disable-next-line react-refresh/only-export-components
const ThumbnailRow = memo(function ThumbnailRow({ page, current, unavailable, onPage, onCanvas }: {
    page: number; current: boolean; unavailable: boolean; onPage(page: number): void;
    onCanvas(page: number, canvas: HTMLCanvasElement | null): void;
}) {
    const canvas = useCallback((node: HTMLCanvasElement | null) => onCanvas(page, node), [onCanvas, page]);
    return <button type="button" className={`pdf-tiled-thumbnail${current ? ' is-current' : ''}`}
        style={{ top: page * ROW }} aria-label={`Page ${page + 1}${unavailable ? ' — thumbnail unavailable' : ''}`}
        aria-current={current ? 'page' : undefined} onClick={() => onPage(page)}
        onContextMenu={event => {
            event.preventDefault(); event.stopPropagation();
            openContextMenu({ x: event.clientX, y: event.clientY, label: 'Page thumbnail', opener: event.currentTarget,
                entries: [{ kind: 'command', id: 'open-page', label: `Go to page ${page + 1}`, run: () => onPage(page) }] });
        }}>
        <span className="pdf-tiled-thumbnail-image"><canvas ref={canvas} width={0} height={0} aria-hidden="true" />
            {unavailable && <span className="pdf-tiled-thumbnail-failure">Thumbnail unavailable</span>}</span>
        <span className="pdf-tiled-thumbnail-label">{page + 1}</span>
    </button>;
});

// eslint-disable-next-line react-refresh/only-export-components
function ThumbnailPanel({ live, queue, document: pdf, profileKey, currentPage, onClose, opener }: {
    live: React.RefObject<Live>; queue: ThumbnailWorkQueue; document: PdfPoolDocument; profileKey: string; currentPage: number;
    onClose(): void; opener: React.RefObject<HTMLButtonElement | null>;
}) {
    const count = pdf.info.pageCount;
    const [initial] = useState(() => Math.max(0, Math.min(count - 1, currentPage)));
    const [range, setRange] = useState<WindowRange>(() => ({ from: initial, to: Math.min(count - 1, initial + 3), middle: initial + 1.5 }));
    const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());
    const scroll = useRef<HTMLDivElement | null>(null), manager = useRef<PdfThumbnailCache | null>(null);
    const canvases = useRef(new Map<number, HTMLCanvasElement>());
    const [token] = useState(() => ({ ...pdf.token }));
    // The callbacks intentionally read the latest owner, not the render that created them.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    const valid = useCallback(() => {
        const state = live.current, saved = token, now = pdf.token;
        return state.open && state.isVisible && state.document === pdf && state.profileKey === profileKey && !pdf.closed &&
            saved.vaultEpoch === now.vaultEpoch && saved.documentId === now.documentId &&
            saved.bytesGeneration === now.bytesGeneration && saved.session === now.session;
    }, [live, pdf, profileKey, token]);
    const onCanvas = useCallback((page: number, node: HTMLCanvasElement | null) => {
        if (node) canvases.current.set(page, node); else canvases.current.delete(page);
        manager.current?.attach(page, node);
    }, []);
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    const onPage = useCallback((page: number) => { if (valid()) live.current.onPage(page); }, [live, valid]);
    const measure = useCallback(() => {
        const el = scroll.current;
        if (!el || !count) return;
        const from = Math.max(0, Math.min(count - 1, Math.floor(el.scrollTop / ROW)));
        const to = Math.max(from, Math.min(count - 1, Math.floor((el.scrollTop + Math.max(1, el.clientHeight) - 1) / ROW)));
        const next = { from, to, middle: (from + to) / 2 };
        manager.current?.setWindow(windowPages(next, count));
        setRange(previous => previous.from === from && previous.to === to ? previous : next);
    }, [count]);
    useLayoutEffect(() => {
        const el = scroll.current;
        if (!el || !valid()) return;
        const cache = new PdfThumbnailCache(pdf, queue, valid, page => live.current.getVariant(page),
            () => setFailed(cache.failures()), message => live.current.onNotice(message));
        manager.current = cache;
        const clearWake = queue.setWake(() => cache.pump());
        for (const [page, canvas] of canvases.current) cache.attach(page, canvas);
        el.scrollTop = initial * ROW;
        measure();
        const observer = new ResizeObserver(measure); observer.observe(el);
        return () => {
            observer.disconnect();
            clearWake();
            manager.current = null; cache.dispose();
        };
    }, [pdf, profileKey, queue, valid, measure, initial, live]);
    useEffect(() => {
        const el = scroll.current, page = currentPage;
        if (!el || page < 0 || page >= count) return;
        if (page * ROW < el.scrollTop) el.scrollTop = page * ROW;
        else if ((page + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (page + 1) * ROW - el.clientHeight;
    }, [currentPage, count]);
    const pages = useMemo(() => {
        const rows: number[] = [];
        for (let page = Math.max(0, range.from - OVERSCAN); page <= Math.min(count - 1, range.to + OVERSCAN); page++) rows.push(page);
        return rows;
    }, [range, count]);
    return <section className="pdf-tiled-thumbnails" role="dialog" aria-label="Page thumbnails"
        onContextMenu={event => {
            event.preventDefault(); event.stopPropagation();
            openContextMenu({ x: event.clientX, y: event.clientY, label: 'Page thumbnails', opener: opener.current,
                entries: [{ kind: 'command', id: 'close-thumbnails', label: 'Hide page thumbnails', run: onClose }] });
        }} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
        <div className="pdf-tiled-thumbnails-header">Pages <button type="button" onClick={onClose} aria-label="Close page thumbnails">×</button></div>
        <div ref={scroll} className="pdf-tiled-thumbnails-scroll" onScroll={measure}>
            <div className="pdf-tiled-thumbnails-inner" style={{ height: count * ROW }}>
                {pages.map(page => <ThumbnailRow key={page} page={page} current={page === currentPage}
                    unavailable={failed.has(page)} onPage={onPage} onCanvas={onCanvas} />)}
            </div>
        </div>
    </section>;
}

/** Pane chrome only: thumbnail pixels never become an export or clipboard surface. */
export function usePdfTiledThumbnails(props: Props): { button: ReactNode; panel: ReactNode } {
    const [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement | null>(null);
    const live = useRef<Live>({ ...props, open });
    // Async completions must see a hidden or replaced pane before layout cleanup runs.
    // eslint-disable-next-line react-hooks/refs
    live.current = { ...props, open };
    const [queue] = useState(createThumbnailWorkQueue);
    const close = useCallback(() => setOpen(false), []);
    useEffect(() => {
        if (!open || !props.isVisible) return;
        return dismissOnEscape(() => { setOpen(false); queueMicrotask(() => opener.current?.focus()); });
    }, [open, props.isVisible]);
    const button = <button ref={opener} type="button" className={`pdf-tiled-thumbnails-toggle${open ? ' is-on' : ''}`}
        onClick={() => setOpen(value => !value)} aria-label="Page thumbnails" aria-pressed={open}
        data-tooltip={open ? 'Hide page thumbnails' : 'Show page thumbnails'}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" />
        </svg>
    </button>;
    const panel = open && props.isVisible ? <ThumbnailPanel key={`${props.document.token.vaultEpoch}:${props.document.token.documentId}:${props.document.token.bytesGeneration}:${props.document.token.session}:${props.profileKey}`}
        live={live} queue={queue} document={props.document} profileKey={props.profileKey} currentPage={props.currentPage} onClose={close} opener={opener} /> : null;
    return { button, panel };
}
