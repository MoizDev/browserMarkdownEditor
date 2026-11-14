import { useRef, useState } from 'react';
import './notebookControls.css';

export interface PagedNavigationProps {
    readonly page: number;
    readonly count: number;
    readonly inverted: boolean;
    readonly thumbnailsOpen: boolean;
    readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
    readonly jump: (page: number) => void;
    readonly toggleInversion: () => void;
    readonly toggleThumbnails: () => void;
}

/** Physical-page navigation is shared by notebooks and PDF ink. */
export function PagedNavigation({ page, count, inverted, thumbnailsOpen, t, jump, toggleInversion, toggleThumbnails }: PagedNavigationProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const [initial, setInitial] = useState('');
    const cancelled = useRef(false);
    const applyPage = () => {
        if (!cancelled.current && draft !== null && draft !== initial) {
            const parsed = Number.parseInt(draft, 10);
            if (Number.isFinite(parsed) && count > 0) jump(Math.min(count, Math.max(1, parsed)) - 1);
        }
        cancelled.current = false;
        setDraft(null);
    };
    const pageLabel = t('paper.pageNumber', { page: page + 1, count });
    return <>
        <button type="button" aria-pressed={thumbnailsOpen} onClick={toggleThumbnails}
            aria-label={t(thumbnailsOpen ? 'paper.hideThumbnails' : 'paper.showThumbnails')}>{t('paper.thumbnails')}</button>
        <button type="button" aria-pressed={inverted} onClick={toggleInversion}
            aria-label={t('paper.invert')} data-tooltip={t(inverted ? 'paper.showColours' : 'paper.invertColours')}>{t('paper.invert')}</button>
        <span className="notebook-page-number"><input aria-label={pageLabel} inputMode="numeric" value={draft ?? String(page + 1)}
            data-tooltip={pageLabel} onFocus={event => { const value = String(page + 1); cancelled.current = false;
                setInitial(value); setDraft(value); event.currentTarget.select(); }}
            onChange={event => setDraft(event.currentTarget.value)} onBlur={applyPage}
            onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); }
            }} /> / {count}</span>
    </>;
}
