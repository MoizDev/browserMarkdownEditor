import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { dismissOnEscape } from '../../utils/escapeDismiss';
import { MAX_PAGES, type NotebookPaper, type PaperRuling, type PaperSize } from '../../utils/paper';
import { focusBoardInteraction } from './chrome/boardFocus';
import { PageNumberField, PageViewToggles } from './PagedNavigation';
import './notebookControls.css';

export interface NotebookControlsProps {
    readonly paper: Readonly<NotebookPaper>;
    readonly page: number;
    readonly readOnly: boolean;
    readonly inverted: boolean;
    readonly thumbnailsOpen: boolean;
    readonly dir: 'ltr' | 'rtl';
    readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
    readonly changePaper: (paper: Readonly<NotebookPaper>) => void;
    readonly addPage: () => void;
    readonly deleteLastPage: () => void;
    readonly jump: (page: number) => void;
    readonly toggleInversion: () => void;
    readonly toggleThumbnails: () => void;
}

export function NotebookControls({ paper, page, readOnly, inverted, thumbnailsOpen, dir, t, changePaper,
    addPage, deleteLastPage, jump, toggleInversion, toggleThumbnails }: NotebookControlsProps) {
    const settings = <>
        <label className="board-paper-field">{t('paper.size')} <select className="board-chrome-select" aria-label={t('paper.size')} disabled={readOnly} value={paper.size}
            onChange={event => changePaper({ ...paper, size: event.currentTarget.value as PaperSize })}>
            <option value="letter">{t('paper.letter')}</option><option value="a4">{t('paper.a4')}</option><option value="legal">{t('paper.legal')}</option>
        </select></label>
        <button type="button" className="board-chrome-tool" disabled={readOnly} aria-label={t('paper.rotate')} data-tooltip={t('paper.rotate')}
            onClick={() => changePaper({ ...paper, orientation: paper.orientation === 'portrait' ? 'landscape' : 'portrait' })}>
            {t(paper.orientation === 'portrait' ? 'paper.portrait' : 'paper.landscape')}</button>
        <label className="board-paper-field">{t('paper.ruling')} <select className="board-chrome-select" aria-label={t('paper.ruling')} disabled={readOnly} value={paper.ruling}
            onChange={event => changePaper({ ...paper, ruling: event.currentTarget.value as PaperRuling })}>
            <option value="lined">{t('paper.lined')}</option><option value="grid">{t('paper.grid')}</option>
            <option value="dotted">{t('paper.dotted')}</option><option value="blank">{t('paper.blank')}</option>
        </select></label>
        <button type="button" className="board-chrome-tool" disabled={readOnly || paper.pageCount >= MAX_PAGES} onClick={addPage}
            aria-label={t('paper.addPage')} data-tooltip={t('paper.addPage')}>{t('paper.addPage')}</button>
        <button type="button" className="board-chrome-tool" disabled={readOnly || paper.pageCount <= 1} onClick={deleteLastPage}
            aria-label={t('paper.deletePage')} data-tooltip={t('paper.deletePage')}>{t('paper.deletePage')}</button>
    </>;
    return <PagedBar dir={dir} t={t} settings={settings}
        toggles={<PageViewToggles inverted={inverted} thumbnailsOpen={thumbnailsOpen} t={t} toggleInversion={toggleInversion} toggleThumbnails={toggleThumbnails} />}
        page={<PageNumberField page={page} count={paper.pageCount} t={t} jump={jump} />} />;
}

export interface PagedBarProps {
    readonly dir: 'ltr' | 'rtl';
    readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
    readonly settings: ReactNode | null;
    readonly toggles: ReactNode;
    readonly page: ReactNode;
}

export function PagedBar({ dir, t, settings, toggles, page }: PagedBarProps) {
    const root = useRef<HTMLDivElement>(null), row = useRef<HTMLDivElement>(null);
    const levels = settings ? 2 : 1;
    const level = useCollapse(root, row, levels, dir);
    const [open, setOpen] = useState(false);
    const settingsAway = !!settings && level >= 1, togglesAway = level >= levels;
    const away = settingsAway || togglesAway;
    const close = useCallback(() => { setOpen(false); focusBoardInteraction(root.current); }, []);
    useEffect(() => { if (!away) setOpen(false); }, [away]);
    useEffect(() => {
        if (!open) return;
        root.current?.querySelector<HTMLElement>('.board-paper-more button:not(:disabled), .board-paper-more select:not(:disabled)')?.focus();
        const removeEscape = dismissOnEscape(close);
        const onPointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
        };
        const bar = root.current;
        let tabbed = false;
        const onKeyDown = (event: KeyboardEvent) => { tabbed = event.key === 'Tab'; };
        const onFocusOut = (event: FocusEvent) => {
            if (tabbed && event.relatedTarget instanceof Node && !bar?.contains(event.relatedTarget)) setOpen(false);
            tabbed = false;
        };
        document.addEventListener('pointerdown', onPointerDown);
        bar?.addEventListener('keydown', onKeyDown);
        bar?.addEventListener('focusout', onFocusOut);
        return () => {
            removeEscape(); document.removeEventListener('pointerdown', onPointerDown);
            bar?.removeEventListener('keydown', onKeyDown); bar?.removeEventListener('focusout', onFocusOut);
        };
    }, [open, close]);
    return <div className="board-paper-collapse" ref={root}>
        <div ref={row} className="board-paper-controls board-chrome-tool-row" role="toolbar" dir={dir} aria-label={t('paper.name')}>
            {settingsAway ? null : settings}
            {togglesAway ? null : toggles}
            {page}
            {away && <button type="button" className="board-chrome-tool board-chrome-tool-icon board-paper-more-button" aria-label={t('paper.name')}
                data-tooltip={t('paper.name')} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}><MoreIcon /></button>}
        </div>
        {open && away && <div role="dialog" aria-label={t('paper.name')} className="board-paper-more" dir={dir}>
            {settingsAway ? settings : null}
            {togglesAway ? toggles : null}
        </div>}
    </div>;
}

function MoreIcon() {
    return <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <circle cx={5} cy={12} r={1.6} /><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} />
    </svg>;
}

function useCollapse(root: RefObject<HTMLDivElement | null>, row: RefObject<HTMLDivElement | null>, levels: number, dir: string): number {
    const [level, setLevel] = useState(0);
    const widths = useRef<number[]>([]);
    useLayoutEffect(() => { widths.current = []; }, [dir]);
    useLayoutEffect(() => {
        const bar = row.current, slot = root.current?.closest<HTMLElement>('.board-paper-slot');
        if (!bar || !slot) return;
        const measure = () => {
            const room = slot.clientWidth;
            if (!room) return;
            const need = bar.scrollWidth;
            widths.current[level] = need;
            if (need > room && level < levels) setLevel(level + 1);
            else if (level > 0 && (widths.current[level - 1] ?? Infinity) <= room) setLevel(level - 1);
        };
        const resized = new ResizeObserver(measure);
        resized.observe(slot);
        resized.observe(bar);
        measure();
        return () => resized.disconnect();
    }, [root, row, level, levels]);
    return level;
}
