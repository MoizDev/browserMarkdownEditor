import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { LocationCause, PdfFindBatch, PdfTextAnchor, PdfTextPage, PdfTextReader, PdfTextTypography } from '../utils/pdfReadingText';
import { pdfTextAnchor } from '../utils/pdfReadingText';
import { emphasisRanges } from '../utils/readingEmphasis';
import { dismissOnEscape } from '../utils/escapeDismiss';
import { openContextMenu } from '../utils/contextMenu';
import { copyText, CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';
import { registerView, type PdfViewInfo } from '../utils/viewRegistry';
import './PdfReadingText.css';

export interface PdfReadingTextProps {
    filePath?: string;
    expectedPageDigest?: string;
    controller: PdfTextReader; isFocused: boolean; anchor?: PdfTextAnchor;
    onShowOriginalPage(index0: number): void;
    onShowOriginal?(): void;
    onLocation(anchor: PdfTextAnchor, cause: LocationCause, pageDigest?: string): void;
    onTextQuality?(quality: 'available' | 'partial' | 'none'): void;
    emphasisEnabled: boolean; typography: PdfTextTypography;
    onTypographyChange?(typography: PdfTextTypography): void;
    onEmphasisChange?(enabled: boolean): void;
}
type PageState = { page?: PdfTextPage; error?: string };
type Endpoint = { page: number; offset: number };
function endpoint(root: HTMLElement, node: Node, offset: number): Endpoint | undefined {
    const el = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('[data-pdf-text-page]');
    if (!el || !root.contains(el)) return;
    const range = document.createRange(); range.selectNodeContents(el);
    try { range.setEnd(node, offset); return { page: Number(el.dataset.pdfTextPage), offset: range.toString().length }; } catch { return; }
}
function domPoint(root: HTMLElement, value: Endpoint): { node: Node; offset: number } | undefined {
    const el = root.querySelector<HTMLElement>(`[data-pdf-text-page="${value.page}"]`);
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let offset = value.offset, node: Node | null;
    while ((node = walker.nextNode())) { if (offset <= (node.textContent?.length ?? 0)) return { node, offset }; offset -= node.textContent?.length ?? 0; }
    return { node: el, offset: el.childNodes.length };
}
/** Copy/report only page-model text; headings, actions and quality notices are app UI. */
function selectedPageText(root: HTMLElement | null, pages: Map<number, PageState>): string | null {
    const selection = root?.ownerDocument.getSelection();
    if (!root || !selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0), parts: string[] = [];
    for (const body of root.querySelectorAll<HTMLElement>('[data-pdf-text-page]')) {
        if (!range.intersectsNode(body)) continue;
        const model = pages.get(Number(body.dataset.pdfTextPage))?.page;
        if (!model) continue;
        const from = body.contains(range.startContainer) ? endpoint(root, range.startContainer, range.startOffset)?.offset ?? 0 : 0;
        const to = body.contains(range.endContainer) ? endpoint(root, range.endContainer, range.endOffset)?.offset ?? model.text.length : model.text.length;
        if (to > from) parts.push(model.text.slice(from, to));
    }
    return parts.length ? parts.join('\n\n') : null;
}
function Text({ page, emphasis }: { page: PdfTextPage; emphasis: boolean }) {
    const ranges = useMemo(() => !emphasis ? [] : emphasisRanges({ text: page.text,
        exclusions: page.intervals.filter(i => i.role !== 'prose').map(i => ({ from: i.from, to: i.to })), tokenBreaks: page.tokenBreaks }), [page, emphasis]);
    const nodes: React.ReactNode[] = [];
    let from = 0;
    for (const range of ranges) {
        if (range.from > from) nodes.push(page.text.slice(from, range.from));
        nodes.push(<span className="pdf-reading-prefix" key={range.from}>{page.text.slice(range.from, range.to)}</span>); from = range.to;
    }
    nodes.push(page.text.slice(from));
    return <div className="pdf-reading-copy" data-pdf-text-page={page.physicalPageIndex} dir="auto">{nodes}</div>;
}

function PdfReadingText({ filePath, expectedPageDigest, controller, isFocused, anchor, onShowOriginalPage, onShowOriginal, onLocation, onTextQuality, emphasisEnabled, typography, onTypographyChange, onEmphasisChange }: PdfReadingTextProps) {
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [localTypography, setLocalTypography] = useState<PdfTextTypography>();
    const effectiveTypography = localTypography ?? typography;
    useEffect(() => { setLocalTypography(undefined); }, [typography]);
    useEffect(() => appearanceOpen ? dismissOnEscape(() => setAppearanceOpen(false)) : undefined, [appearanceOpen]);
    function changeTypography(patch: Partial<PdfTextTypography>) {
        const next = { ...effectiveTypography, ...patch };
        if (onTypographyChange) onTypographyChange(next); else setLocalTypography(next);
    }
    const root = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null);
    useEffect(() => { if (isFocused) scroll.current?.focus({ preventScroll: true }); }, [isFocused]);
    const [count, setCount] = useState(0), [current, setCurrent] = useState(anchor?.physicalPageIndex ?? 0);
    const [pages, setPages] = useState<Map<number, PageState>>(new Map());
    const [retry, setRetry] = useState(0), [query, setQuery] = useState(''), [search, setSearch] = useState<PdfFindBatch>();
    const [message, setMessage] = useState(''), [finding, setFinding] = useState(false);
    const findAbort = useRef<AbortController | null>(null);
    const navigationEpoch = useRef(0);
    const expectedDigest = useRef(expectedPageDigest); expectedDigest.current = expectedPageDigest;
    const reportLocation = (value: PdfTextAnchor, cause: LocationCause) => onLocation(value, cause, models.current.get(value.physicalPageIndex)?.page?.digest);
    const callbacks = useRef({ onLocation: reportLocation, onShowOriginalPage, onTextQuality }); callbacks.current = { onLocation: reportLocation, onShowOriginalPage, onTextQuality };
    const models = useRef(pages); models.current = pages;
    const pending = useRef<{ anchor: PdfTextAnchor; cause: LocationCause } | null>(null);
    const userScroll = useRef(false);
    const programmaticUntil = useRef(0);
    const lastAnchor = useRef<PdfTextAnchor | undefined>(anchor);
    const [presentation, setPresentation] = useState({ emphasis: emphasisEnabled, typography: effectiveTypography });
    const settleCancel = useRef<() => void>(() => {});
    const pin = useRef<{ anchor: PdfTextAnchor; selection?: { anchor: Endpoint; focus: Endpoint } } | null>(null);
    const currentRef = useRef(current); currentRef.current = current;
    const [jump, setJump] = useState(String(current + 1));
    useEffect(() => { setJump(String(current + 1)); }, [current]);
    const capture = useCallback((): PdfTextAnchor | undefined => {
        const box = scroll.current, host = root.current;
        if (!box || !host) return lastAnchor.current;
        const rect = box.getBoundingClientRect();
        const sections = [...host.querySelectorAll<HTMLElement>('[data-pdf-text-page]')];
        const body = sections.find(el => el.getBoundingClientRect().bottom > rect.top + 8);
        if (!body) return lastAnchor.current;
        const index = Number(body.dataset.pdfTextPage), page = models.current.get(index)?.page;
        if (!page) return lastAnchor.current;
        const b = body.getBoundingClientRect();
        const caret = document.caretRangeFromPoint(Math.min(rect.right - 12, b.left + 6), Math.max(rect.top + 8, b.top + 2));
        const point = caret && body.contains(caret.startContainer) ? endpoint(host, caret.startContainer, caret.startOffset) : undefined;
        let offset = point?.offset ?? 0;
        while (offset > 0 && !/\s/u.test(page.text[offset - 1]) && (point?.offset ?? 0) - offset < 200) offset--;
        const target = domPoint(host, { page: index, offset });
        let y = b.top;
        if (target) { const r = document.createRange(); r.setStart(target.node, target.offset); r.collapse(true); y = r.getBoundingClientRect().top || y; }
        return pdfTextAnchor(page, offset, y - rect.top);
    }, []);
    const place = useCallback((value: PdfTextAnchor) => {
        const host = root.current, box = scroll.current;
        if (!host || !box) return false;
        const point = domPoint(host, { page: value.physicalPageIndex, offset: value.offsetUTF16 });
        if (!point) return false;
        const range = document.createRange(); range.setStart(point.node, point.offset); range.collapse(true);
        const body = host.querySelector<HTMLElement>(`[data-pdf-text-page="${value.physicalPageIndex}"]`)!;
        const y = range.getBoundingClientRect().top || body.getBoundingClientRect().top;
        programmaticUntil.current = performance.now() + 100;
        box.scrollTop += y - box.getBoundingClientRect().top - (value.alignHint ?? 0);
        lastAnchor.current = value;
        return true;
    }, []);
    useEffect(() => {
        const cancel = new AbortController();
        void controller.getPageCount(cancel.signal).then(setCount).catch(error => { if (!cancel.signal.aborted) setMessage(String(error)); });
        return () => { cancel.abort(); findAbort.current?.abort(); };
    }, [controller]);
    useEffect(() => {
        if (!count) return;
        controller.setWindow(current);
        const cancel = new AbortController(), indices = [current, current - 1, current + 1, current - 2, current + 2].filter(n => n >= 0 && n < count);
        setPages(old => new Map([...old].filter(([index]) => indices.includes(index))));
        // Queue visible demand first. Cancellation removes queued work and cancels
        // the active text stream; unrelated PDF consumers retain their leases.
        for (const index of indices) void controller.getPage(index, cancel.signal).then(page => {
            if (!cancel.signal.aborted) setPages(old => new Map(old).set(index, { page }));
        }).catch(error => { if (!cancel.signal.aborted) setPages(old => new Map(old).set(index, { error: String(error) })); });
        return () => cancel.abort();
    }, [controller, current, count, retry]);
    const navigate = useCallback(async (value: PdfTextAnchor, cause: LocationCause) => {
        const epoch = ++navigationEpoch.current;
        try {
            const resolved = await controller.navigate(value);
            if (cause === 'restore' && expectedDigest.current) {
                const model = await controller.getPage(resolved.physicalPageIndex);
                if (model.digest !== expectedDigest.current && navigationEpoch.current === epoch) setMessage('Extracted text changed; restored by quote or approximately within this physical page.');
            }
            if (navigationEpoch.current !== epoch) return;
            pending.current = { anchor: resolved, cause };
            setCurrent(resolved.physicalPageIndex);
            setRetry(n => n + 1);
        } catch (error) { if (navigationEpoch.current === epoch) setMessage(String(error)); }
    }, [controller]);
    useEffect(() => { const epoch = navigationEpoch; return () => { ++epoch.current; }; }, [controller]);
    useEffect(() => { if (anchor) void navigate(anchor, 'restore'); }, [anchor, navigate]);
    useEffect(() => {
        const state = pages.get(current);
        if (state) callbacks.current.onTextQuality?.(state.page ? state.page.quality === 'available' ? 'available' : state.page.text.trim() ? 'partial' : 'none' : 'none');
    }, [pages, current]);
    useLayoutEffect(() => () => {
        settleCancel.current();
        const value = capture();
        if (value) callbacks.current.onLocation(value, 'layout');
    }, [capture]);
    const countRef = useRef(count); countRef.current = count;
    useEffect(() => {
        if (!filePath) return;
        return registerView(filePath, {
            kind: 'pdf',
            describe(): PdfViewInfo {
                const box = scroll.current, rect = box?.getBoundingClientRect();
                const value = capture(), visiblePages: number[] = [], visibleText: string[] = [];
                if (box && rect) for (const el of box.querySelectorAll<HTMLElement>('[data-pdf-text-page]')) {
                    const r = el.getBoundingClientRect(), index = Number(el.dataset.pdfTextPage), model = models.current.get(index)?.page;
                    if (r.bottom <= rect.top || r.top >= rect.bottom || !model) continue;
                    visiblePages.push(index + 1);
                    const start = value?.physicalPageIndex === index ? value.offsetUTF16 : 0;
                    const caret = document.caretRangeFromPoint(Math.min(rect.right - 8, r.right - 2), Math.min(rect.bottom - 2, r.bottom - 2));
                    const end = caret && el.contains(caret.startContainer) ? endpoint(box, caret.startContainer, caret.startOffset)?.offset : undefined;
                    visibleText.push(model.text.slice(start, Math.min(end ?? model.text.length, start + 8000)));
                }
                const selected = selectedPageText(box, models.current)?.slice(0, 8000) ?? null;
                return { kind: 'pdf', surface: 'text', pageCount: countRef.current, page: (value?.physicalPageIndex ?? currentRef.current) + 1,
                    offset: 0, zoom: 1, visiblePages, selectedText: selected, inverted: false,
                    textAnchor: value, visibleCanonicalText: visibleText.join('\n').slice(0, 8000) };
            },
            async pdfText(pages) {
                const result: Array<{ page: number; text: string }> = [];
                for (const page of pages) if (Number.isInteger(page) && page > 0 && page <= countRef.current) result.push({ page, text: (await controller.getPage(page - 1)).text });
                return result;
            },
        });
    }, [filePath, controller, capture]);
    useLayoutEffect(() => {
        if (pending.current && place(pending.current.anchor)) {
            callbacks.current.onLocation(pending.current.anchor, pending.current.cause);
            const indices = [current - 2, current - 1, current, current + 1, current + 2].filter(index => index >= 0 && index < count);
            if (indices.every(index => pages.has(index))) pending.current = null;
        }
    }, [pages, place, current, count]);
    // Capture against the OLD text nodes before applying new weights/fonts. The
    // second layout pass restores source offsets, including a cross-prefix selection.
    useLayoutEffect(() => {
        if (presentation.emphasis === emphasisEnabled && presentation.typography === effectiveTypography) return;
        const value = capture(), host = root.current, selection = window.getSelection();
        if (value && host) {
            const a = selection?.anchorNode ? endpoint(host, selection.anchorNode, selection.anchorOffset) : undefined;
            const f = selection?.focusNode ? endpoint(host, selection.focusNode, selection.focusOffset) : undefined;
            pin.current = { anchor: value, ...(a && f ? { selection: { anchor: a, focus: f } } : {}) };
        }
        setPresentation({ emphasis: emphasisEnabled, typography: effectiveTypography });
    }, [emphasisEnabled, effectiveTypography, presentation, capture]);
    useLayoutEffect(() => {
        if (!pin.current || !root.current) return;
        const held = pin.current; pin.current = null;
        settleCancel.current();
        let alive = true, frame = 0;
        const restore = () => {
            if (!alive || !root.current) return;
            place(held.anchor);
            if (held.selection) {
                const a = domPoint(root.current, held.selection.anchor), f = domPoint(root.current, held.selection.focus);
                if (a && f) window.getSelection()?.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
            }
        };
        restore();
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); };
        const observer = new ResizeObserver(schedule);
        const body = root.current.querySelector(`[data-pdf-text-page="${held.anchor.physicalPageIndex}"]`);
        if (body) observer.observe(body);
        document.fonts.addEventListener('loadingdone', schedule);
        void document.fonts.ready.then(() => { if (alive) schedule(); });
        const timer = setTimeout(() => settleCancel.current(), 500);
        const cancel = () => { alive = false; observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer); document.fonts.removeEventListener('loadingdone', schedule); };
        settleCancel.current = cancel;
        callbacks.current.onLocation(held.anchor, 'layout');
        return cancel;
    }, [presentation, place]);
    useEffect(() => {
        if (!isFocused) return;
        const key = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && root.current?.contains(document.activeElement)) {
                event.preventDefault(); event.stopPropagation(); searchInput.current?.focus(); searchInput.current?.select();
            }
        };
        const el = root.current; el?.addEventListener('keydown', key, true);
        return () => el?.removeEventListener('keydown', key, true);
    }, [isFocused]);
    async function find() {
        findAbort.current?.abort(); const cancel = new AbortController(); findAbort.current = cancel; setFinding(true); setSearch(undefined);
        try { for await (const batch of controller.find(query, cancel.signal)) if (!cancel.signal.aborted) setSearch(batch); }
        catch (error) { if (!cancel.signal.aborted) setMessage(String(error)); }
        finally { if (findAbort.current === cancel) setFinding(false); }
    }
    function pageJump(index: number) {
        if (!Number.isFinite(index)) return;
        void navigate({ physicalPageIndex: Math.min(count - 1, Math.max(0, index)), offsetUTF16: 0, affinity: 'after', quote: '', before: '', after: '' }, 'user-navigation');
    }
    const t = presentation.typography;
    const usableText = !!pages.get(current)?.page?.text.trim();
    const style = { '--pdf-reading-size': `${Math.min(40, Math.max(12, t.size))}px`, '--pdf-reading-leading': Math.min(2.2, Math.max(1.2, t.leading)),
        '--pdf-reading-measure': { compact: '48ch', comfortable: '65ch', wide: '80ch' }[t.measure],
        '--pdf-reading-margin': { small: '12px', medium: '24px', large: '40px' }[t.margins],
        fontFamily: t.family === 'serif' ? 'Georgia, serif' : t.family === 'sans' ? 'system-ui, sans-serif' : 'inherit' } as CSSProperties;
    const indices = [current - 2, current - 1, current, current + 1, current + 2].filter(index => index >= 0 && index < count);
    return <div ref={root} className="pdf-reading" data-reading-theme={t.theme} style={style}
        onDragOver={e => e.preventDefault()} onDrop={e => e.preventDefault()}
        onCopy={event => { if (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable=true]')) return; const text = selectedPageText(scroll.current, models.current); if (text !== null) { event.preventDefault(); event.clipboardData.setData('text/plain', text); } }}
        onContextMenu={event => {
            event.preventDefault();
            const selection = selectedPageText(scroll.current, models.current) ?? '';
            openContextMenu({ label: 'PDF text', opener: scroll.current, x: event.clientX, y: event.clientY, entries: [
                { kind: 'command', id: 'pdf-copy', label: 'Copy', disabled: !selection, reason: !selection ? 'Select text to copy' : undefined, run: () => { void copyText(selection).then(ok => { if (!ok) setMessage(CLIPBOARD_WRITE_BLOCKED); }); } },
                { kind: 'command', id: 'pdf-original', label: 'Show original page', run: () => callbacks.current.onShowOriginalPage(currentRef.current) },
            ] });
        }}>
        <div className="pdf-reading-toolbar">
            <span className="pdf-reading-label">Text · extracted from PDF</span>
            <button type="button" aria-label="Reading appearance" aria-expanded={appearanceOpen} onClick={() => setAppearanceOpen(open => !open)}>Aa</button>
            {onEmphasisChange && <button type="button" aria-label="Word emphasis" aria-pressed={usableText ? emphasisEnabled : undefined}
                aria-disabled={!usableText || undefined} aria-description={!usableText ? `Preference ${emphasisEnabled ? 'On' : 'Off'}; inactive on this page. No usable extracted text; view Original.` : undefined}
                onClick={() => { if (usableText) onEmphasisChange(!emphasisEnabled); }}>Word emphasis</button>}
            <button type="button" onClick={() => onShowOriginal ? onShowOriginal() : callbacks.current.onShowOriginalPage(current)}>Original PDF</button>
            <div className="pdf-reading-pages" role="group" aria-label="PDF physical page navigation">
                <button type="button" aria-label="Previous physical page" disabled={current <= 0} onClick={() => pageJump(current - 1)}>‹</button>
                <form onSubmit={e => { e.preventDefault(); pageJump(Number(jump) - 1); }}><label>Page <input aria-label="Physical page" inputMode="numeric" value={jump} onChange={e => setJump(e.target.value)} onBlur={() => setJump(String(current + 1))} /></label><span> / {count || '…'}</span></form>
                <button type="button" aria-label="Next physical page" disabled={!count || current + 1 >= count} onClick={() => pageJump(current + 1)}>›</button>
            </div>
        </div>
        {appearanceOpen && <fieldset className="pdf-reading-appearance"><legend>Reading appearance</legend>
            <label>Font <select value={effectiveTypography.family} onChange={e => changeTypography({ family: e.target.value as PdfTextTypography['family'] })}><option value="publisher">App font</option><option value="serif">Serif</option><option value="sans">Sans serif</option></select></label>
            <label>Size <input aria-label="Reading font size" type="range" min="12" max="40" value={effectiveTypography.size} onChange={e => changeTypography({ size: Number(e.target.value) })} />{effectiveTypography.size}px</label>
            <label>Line spacing <input aria-label="Reading line spacing" type="range" min="1.2" max="2.2" step="0.05" value={effectiveTypography.leading} onChange={e => changeTypography({ leading: Number(e.target.value) })} /></label>
            <label>Line width <select value={effectiveTypography.measure} onChange={e => changeTypography({ measure: e.target.value as PdfTextTypography['measure'] })}><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="wide">Wide</option></select></label>
            <label>Margins <select value={effectiveTypography.margins} onChange={e => changeTypography({ margins: e.target.value as PdfTextTypography['margins'] })}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label>
            <label>Theme <select value={effectiveTypography.theme} onChange={e => changeTypography({ theme: e.target.value as PdfTextTypography['theme'] })}><option value="follow-app">Follow app</option><option value="light">Light</option><option value="sepia">Sepia</option><option value="dark">Dark</option></select></label>
        </fieldset>}
        <p className="pdf-reading-warning">Layout, columns, tables and annotations may not be preserved. Images and links remain in Original. Existing text layers can differ from page images. No OCR is performed.</p>
        <form className="pdf-reading-find" role="search" onSubmit={e => { e.preventDefault(); void find(); }}>
            <input ref={searchInput} aria-label="Find in extracted PDF text" maxLength={256} value={query} placeholder="Find across physical pages" onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); findAbort.current?.abort(); setFinding(false); setSearch(undefined); scroll.current?.focus(); } }} />
            <button type="submit" disabled={!query.trim()}>Find</button>{finding && <button type="button" onClick={() => { findAbort.current?.abort(); setFinding(false); }}>Stop</button>}
        </form>
        {search && <div className="pdf-reading-results" aria-label="Extracted PDF search results">
            <p role="status">{search.hits.length} matches · {search.pagesDone}/{search.pagesTotal} pages searched{search.truncated ? ' · Search limit reached (500 matches / 16 MiB)' : ''}{search.unavailablePages.length ? ` · ${search.unavailablePages.length} pages have absent, partial or unavailable text` : ''}{!search.done && !finding ? ' · Stopped; coverage incomplete' : ''}</p>
            <button type="button" onClick={() => { findAbort.current?.abort(); setFinding(false); setSearch(undefined); scroll.current?.focus(); }}>Close results</button>
            <ol>{search.hits.map((hit, i) => <li key={i}><button type="button" onClick={() => { void navigate(hit.anchor, 'search'); scroll.current?.focus(); }}>Page {hit.anchor.physicalPageIndex + 1} · {hit.snippet}</button></li>)}</ol>
        </div>}
        {message && <p role="status" className="pdf-reading-warning">{message}</p>}
        <div className="pdf-reading-scroll" ref={scroll} role="region" aria-label="Text · extracted from PDF" tabIndex={0}
            onWheel={() => { settleCancel.current(); pin.current = null; userScroll.current = true; programmaticUntil.current = 0; }} onPointerDown={() => { settleCancel.current(); pin.current = null; userScroll.current = true; programmaticUntil.current = 0; }}
            onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) { settleCancel.current(); userScroll.current = true; programmaticUntil.current = 0; } }}
            onScroll={() => {
                if (pending.current || pin.current || performance.now() < programmaticUntil.current) return;
                const value = capture(); if (!value) return;
                lastAnchor.current = value; callbacks.current.onLocation(value, userScroll.current ? 'user-scroll' : 'layout');
                if (value.physicalPageIndex !== currentRef.current) {
                    pending.current = { anchor: value, cause: 'layout' }; setCurrent(value.physicalPageIndex);
                }
            }}>
            {indices.map(index => {
                const state = pages.get(index);
                return <section className="pdf-reading-page" key={index} aria-label={`Physical page ${index + 1}`}>
                    <header><h2>Page {index + 1}</h2><button type="button" onClick={() => callbacks.current.onShowOriginalPage(index)}>Show original page {index + 1}</button></header>
                    {!state && <p role="status">Extracting page {index + 1}…</p>}
                    {state?.error && <p role="alert">Could not extract this page. {state.error} <button type="button" onClick={() => { if (index !== current) pageJump(index); else setRetry(n => n + 1); }}>Retry page {index + 1}</button></p>}
                    {state?.page && <>{state.page.reasons.length > 0 && <p className="pdf-reading-quality">{state.page.reasons.join(' ')}</p>}<Text page={state.page} emphasis={presentation.emphasis} /></>}
                </section>;
            })}
        </div>
    </div>;
}
export default React.memo(PdfReadingText);
