import { useEffect, useRef, useState } from 'react';

interface Props {
    /** Zero-based physical page, never a PDF PageLabels index. */
    page: number;
    pageCount: number;
    onNavigate: (page: number) => void;
}

/** An unfinished page number is not a navigation. Keep scrolling from
 * replacing the reader's draft, and restore the actual page on blur. */
export default function PdfTiledPageField({ page, pageCount, onNavigate }: Props) {
    const [draft, setDraft] = useState(String(page + 1));
    const editing = useRef(false);
    const current = useRef(page);
    useEffect(() => {
        current.current = page;
        if (!editing.current) setDraft(String(page + 1));
    }, [page]);
    const restore = () => setDraft(String(current.current + 1));
    return <div className="pdf-viewer-pill pdf-viewer-pages">
        <input className="pdf-viewer-page-input" aria-label="Current page" type="text" inputMode="numeric" value={draft}
            onFocus={() => { editing.current = true; }}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => { editing.current = false; restore(); }}
            onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); restore(); event.currentTarget.blur(); return; }
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const text = draft.trim();
                const value = Number(text);
                if (!text || !Number.isSafeInteger(value) || pageCount < 1) { restore(); return; }
                const target = Math.min(pageCount, Math.max(1, value));
                current.current = target - 1;
                setDraft(String(target));
                onNavigate(target - 1);
                event.currentTarget.blur();
            }} />
        <span>/ {pageCount}</span>
    </div>;
}
