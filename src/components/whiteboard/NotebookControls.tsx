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

/** This is physical paper; logical sheets have a separate menu in the header. */
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
    /** The paper's own settings (a notebook's), the first to leave the row; null for a PDF, whose pages are fixed. */
    readonly settings: ReactNode | null;
    /** Thumbnails and inversion: they leave the row after the settings. */
    readonly toggles: ReactNode;
    /** The page number: always on the row. */
    readonly page: ReactNode;
}

/** The paged bar under the header: one row, always. What the pane is too narrow to show moves into a popover behind its last
 * button, the settings first and then the view toggles, as the tool bar moves its tools into More tools (ToolStrip). Wrapped
 * instead, a notebook's bar in a 339 px pane (three columns at 1280 px) took four rows, 160 px, over the top of the page. */
export function PagedBar({ dir, t, settings, toggles, page }: PagedBarProps) {
    const root = useRef<HTMLDivElement>(null), row = useRef<HTMLDivElement>(null);
    const levels = settings ? 2 : 1;
    const level = useCollapse(root, row, levels, dir);
    const [open, setOpen] = useState(false);
    // Settings leave first; at the last level the toggles follow them.
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
        // Tab past the last control closes it: left open, the keyboard was in the tool bar with this dialog still over the page
        // (measured: eight Tabs from the popover, focus in the board toolbar, popover still shown). Only Tab: a control in
        // here hands the keyboard to the board when it is used, and closing on that shut the popover on every Invert click.
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

/** The three dots of the header's own overflow, sized as the bar's icons. */
function MoreIcon() {
    return <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
        <circle cx={5} cy={12} r={1.6} /><circle cx={12} cy={12} r={1.6} /><circle cx={19} cy={12} r={1.6} />
    </svg>;
}

/** How many groups leave the row: 0 (all on it) up to `levels`. Each level's natural width is measured when it is shown, so the
 * bar steps back only when the wider level is known to fit: no level is tried and undone on every resize. The room is the
 * slot's, which spans the chrome column (the pane less its gutters). */
function useCollapse(root: RefObject<HTMLDivElement | null>, row: RefObject<HTMLDivElement | null>, levels: number, dir: string): number {
    const [level, setLevel] = useState(0);
    const widths = useRef<number[]>([]);
    // A new language or direction changes every width: the measured ones are stale.
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
