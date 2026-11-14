import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { RawOutlineNode } from '../pdf/engine/types';
import type { PdfLinkDestination } from '../pdf/pdfLinkModel';
import type { PdfPoolDocument } from '../pdf/pool/types';
import { dismissOnEscape } from '../utils/escapeDismiss';
import './PdfTiledOutline.css';

interface Options {
    document: PdfPoolDocument;
    isVisible: boolean;
    onNavigate(dest: PdfLinkDestination): void;
    onNotice(message: string): void;
}
interface Row { node: RawOutlineNode; id: string; parent?: string; depth: number }
const HEIGHT = 28, OVERSCAN = 8, MAX_ROWS = 100_000, MAX_DEPTH = 64;

function flatten(tree: readonly RawOutlineNode[], collapsed: ReadonlySet<string>): Row[] {
    const rows: Row[] = [], stack: Array<{ node: RawOutlineNode; id: string; parent?: string; depth: number }> = [];
    for (let i = tree.length - 1; i >= 0; i--) stack.push({ node: tree[i], id: String(i), depth: 1 });
    while (stack.length && rows.length < MAX_ROWS) {
        const row = stack.pop()!;
        rows.push(row);
        if (row.depth >= MAX_DEPTH || collapsed.has(row.id)) continue;
        for (let i = row.node.children.length - 1; i >= 0; i--) {
            stack.push({ node: row.node.children[i], id: `${row.id}-${i}`, parent: row.id, depth: row.depth + 1 });
        }
    }
    return rows;
}

/** Outline is fetched only while the panel is visible; the document owns the source lease. */
export function usePdfTiledOutline(options: Options): { button: ReactNode; panel: ReactNode } {
    const live = useRef(options);
    useLayoutEffect(() => { live.current = options; });
    const buttonRef = useRef<HTMLButtonElement>(null), panelRef = useRef<HTMLDivElement>(null), treeRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef<AbortController | null>(null);
    const prefix = useId().replaceAll(':', ''), [open, setOpen] = useState(false);
    const [tree, setTree] = useState<RawOutlineNode[] | null>(null), [loading, setLoading] = useState(false);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()), [active, setActive] = useState('');
    const [scroll, setScroll] = useState(0), [height, setHeight] = useState(320);
    const rows = useMemo(() => tree ? flatten(tree, collapsed) : [], [tree, collapsed]);
    const activeIndex = Math.max(0, rows.findIndex(row => row.id === active));
    const close = useCallback((restore: boolean) => {
        requestRef.current?.abort(); requestRef.current = null;
        setOpen(false); setTree(null); setLoading(false); setCollapsed(new Set()); setActive(''); setScroll(0);
        if (restore) buttonRef.current?.focus();
    }, []);
    useEffect(() => {
        if (!open || !options.isVisible) return;
        const controller = new AbortController(), doc = options.document;
        requestRef.current = controller;
        setLoading(true); setTree(null);
        void doc.outline({ priority: 1, signal: controller.signal }).then(result => {
            if (controller.signal.aborted || doc.closed || !live.current.isVisible || live.current.document !== doc) return;
            setTree(result); setActive(result.length ? '0' : ''); setLoading(false);
        }, error => {
            if (controller.signal.aborted || !live.current.isVisible || live.current.document !== doc) return;
            setLoading(false); setTree([]);
            live.current.onNotice(error instanceof Error ? 'PDF contents could not be loaded.' : 'PDF contents are unavailable.');
        });
        return () => { controller.abort(); if (requestRef.current === controller) requestRef.current = null; };
    }, [open, options.document, options.isVisible]);
    useLayoutEffect(() => { if (!options.isVisible) close(false); }, [options.isVisible, close]);
    useEffect(() => { close(false); }, [options.document, close]);
    useEffect(() => {
        if (!open || !options.isVisible) return;
        treeRef.current?.focus();
        const dismiss = dismissOnEscape(() => close(true));
        const outside = (event: PointerEvent) => {
            if (event.target instanceof Node && (panelRef.current?.contains(event.target) || buttonRef.current?.contains(event.target))) return;
            close(false);
        };
        window.addEventListener('pointerdown', outside, true);
        return () => { dismiss(); window.removeEventListener('pointerdown', outside, true); };
    }, [open, options.isVisible, close]);
    useLayoutEffect(() => {
        const element = treeRef.current;
        if (!open || !element) return;
        const measure = () => setHeight(element.clientHeight);
        measure();
        const observer = new ResizeObserver(measure); observer.observe(element);
        return () => observer.disconnect();
    }, [open]);
    const toggle = (id: string) => setCollapsed(old => {
        const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next;
    });
    const choose = (index: number) => {
        const row = rows[index], element = treeRef.current;
        if (!row) return;
        setActive(row.id);
        if (element) {
            const top = index * HEIGHT, bottom = top + HEIGHT;
            if (top < element.scrollTop) element.scrollTop = top;
            else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
        }
    };
    const activate = (row: Row) => {
        if (row.node.dest) { live.current.onNavigate(row.node.dest); close(false); }
        else if (row.node.children.length) toggle(row.id);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const row = rows[activeIndex];
        if (!row) return;
        let handled = true;
        switch (event.key) {
            case 'ArrowDown': choose(Math.min(rows.length - 1, activeIndex + 1)); break;
            case 'ArrowUp': choose(Math.max(0, activeIndex - 1)); break;
            case 'Home': choose(0); break;
            case 'End': choose(rows.length - 1); break;
            case 'ArrowRight':
                if (row.node.children.length && collapsed.has(row.id)) toggle(row.id);
                else if (row.node.children.length && rows[activeIndex + 1]?.parent === row.id) choose(activeIndex + 1);
                break;
            case 'ArrowLeft':
                if (row.node.children.length && !collapsed.has(row.id)) toggle(row.id);
                else if (row.parent) { const index = rows.findIndex(item => item.id === row.parent); if (index >= 0) choose(index); }
                break;
            case 'Enter': case ' ': activate(row); break;
            default: handled = false;
        }
        if (handled) { event.preventDefault(); event.stopPropagation(); }
    };
    const first = Math.max(0, Math.floor(scroll / HEIGHT) - OVERSCAN), last = Math.min(rows.length, Math.ceil((scroll + height) / HEIGHT) + OVERSCAN);
    const indices = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
    if (rows.length && (activeIndex < first || activeIndex >= last)) indices.push(activeIndex);
    const button = <button ref={buttonRef} type="button" data-tooltip="Contents" aria-label="Contents" aria-expanded={open}
        aria-controls={`${prefix}-panel`} onClick={() => open ? close(false) : setOpen(true)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M5 5h14M5 9h14M5 13h10M5 17h10M5 21h7" />
        </svg>
    </button>;
    const panel = open && options.isVisible ? <div ref={panelRef} id={`${prefix}-panel`} className="pdf-outline-panel" role="dialog" aria-label="PDF contents"
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
        onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
        <div className="pdf-outline-header"><span>Contents</span><button type="button" aria-label="Close contents" data-tooltip="Close" onClick={() => close(true)}>×</button></div>
        <div ref={treeRef} className="pdf-outline-tree" role="tree" aria-label="PDF contents" tabIndex={0}
            aria-activedescendant={rows.length ? `${prefix}-row-${rows[activeIndex].id}` : undefined}
            onKeyDown={onKeyDown} onScroll={event => setScroll(event.currentTarget.scrollTop)}>
            {loading ? <div className="pdf-outline-message">Loading contents…</div> : tree && !rows.length ? <div className="pdf-outline-message">No contents available.</div> : null}
            <div style={{ height: rows.length * HEIGHT, position: 'relative' }}>
                {indices.map(index => {
                    const row = rows[index], branch = row.node.children.length > 0, expanded = !collapsed.has(row.id);
                    return <div key={row.id} id={`${prefix}-row-${row.id}`} role="treeitem" aria-level={row.depth}
                        aria-expanded={branch ? expanded : undefined} aria-selected={index === activeIndex}
                        className={`pdf-outline-row${index === activeIndex ? ' is-active' : ''}`}
                        style={{ top: index * HEIGHT, paddingLeft: Math.min((row.depth - 1) * 14, 224) + 4 }}
                        onClick={() => { choose(index); activate(row); }}>
                        {branch ? <button type="button" tabIndex={-1} className="pdf-outline-toggle" aria-label={expanded ? 'Collapse' : 'Expand'}
                            onClick={event => { event.stopPropagation(); choose(index); toggle(row.id); treeRef.current?.focus(); }}>{expanded ? '▾' : '▸'}</button>
                            : <span className="pdf-outline-spacer" />}
                        <span className="pdf-outline-title">{row.node.title || 'Untitled'}</span>
                    </div>;
                })}
            </div>
        </div>
    </div> : null;
    return { button, panel };
}
