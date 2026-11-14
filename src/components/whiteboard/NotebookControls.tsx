import { useRef, useState } from 'react';
import type { NotebookPaper, PaperRuling, PaperSize } from '../../utils/paper';
import './notebookControls.css';

export interface NotebookControlsProps {
    readonly paper: Readonly<NotebookPaper>;
    readonly page: number;
    readonly readOnly: boolean;
    readonly inverted: boolean;
    readonly thumbnailsOpen: boolean;
    readonly changePaper: (paper: Readonly<NotebookPaper>) => void;
    readonly addPage: () => void;
    readonly deleteLastPage: () => void;
    readonly jump: (page: number) => void;
    readonly toggleInversion: () => void;
    readonly toggleThumbnails: () => void;
}

/** This is physical paper; logical sheets have a separate menu in the header. */
export function NotebookControls({ paper, page, readOnly, inverted, thumbnailsOpen, changePaper,
    addPage, deleteLastPage, jump, toggleInversion, toggleThumbnails }: NotebookControlsProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const [initial, setInitial] = useState('');
    const cancelled = useRef(false);
    const applyPage = () => {
        if (!cancelled.current && draft !== null && draft !== initial) {
            const parsed = Number.parseInt(draft, 10);
            if (Number.isFinite(parsed)) jump(Math.min(paper.pageCount, Math.max(1, parsed)) - 1);
        }
        cancelled.current = false;
        setDraft(null);
    };
    return <div className="notebook-controls" role="toolbar" aria-label="Notebook paper">
        <label>Page size <select aria-label="Page size" disabled={readOnly} value={paper.size}
            onChange={event => changePaper({ ...paper, size: event.currentTarget.value as PaperSize })}>
            <option value="letter">Letter</option><option value="a4">A4</option><option value="legal">Legal</option>
        </select></label>
        <button type="button" disabled={readOnly} aria-label="Rotate the pages" data-tooltip="Rotate the pages"
            onClick={() => changePaper({ ...paper, orientation: paper.orientation === 'portrait' ? 'landscape' : 'portrait' })}>
            {paper.orientation === 'portrait' ? 'Portrait' : 'Landscape'}</button>
        <label>Ruling <select aria-label="Ruling" disabled={readOnly} value={paper.ruling}
            onChange={event => changePaper({ ...paper, ruling: event.currentTarget.value as PaperRuling })}>
            <option value="lined">Lined</option><option value="grid">Grid</option>
            <option value="dotted">Dotted</option><option value="blank">Blank</option>
        </select></label>
        <button type="button" disabled={readOnly || paper.pageCount >= 500} onClick={addPage}
            aria-label="Add a page" data-tooltip="Add a page">+ Page</button>
        <button type="button" disabled={readOnly || paper.pageCount <= 1} onClick={deleteLastPage}
            aria-label="Delete the last page" data-tooltip="Delete the last page">− Page</button>
        <button type="button" aria-pressed={thumbnailsOpen} onClick={toggleThumbnails}
            aria-label={thumbnailsOpen ? 'Hide page thumbnails' : 'Show page thumbnails'}>Pages</button>
        <button type="button" aria-pressed={inverted} onClick={toggleInversion}
            aria-label="Invert page colours" data-tooltip={inverted ? 'Show pages in their own colours' : 'Invert pages for reading in the dark'}>Invert</button>
        <span className="notebook-page-number"><input aria-label="Page number" inputMode="numeric" value={draft ?? String(page + 1)}
            data-tooltip="Current page: type a number and press Enter to jump"
            onFocus={event => { const value = String(page + 1); cancelled.current = false; setInitial(value); setDraft(value); event.currentTarget.select(); }}
            onChange={event => setDraft(event.currentTarget.value)} onBlur={applyPage}
            onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); }
            }} /> / {paper.pageCount}</span>
    </div>;
}
