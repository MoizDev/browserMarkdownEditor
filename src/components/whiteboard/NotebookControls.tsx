import { MAX_PAGES, type NotebookPaper, type PaperRuling, type PaperSize } from '../../utils/paper';
import { PagedNavigation } from './PagedNavigation';
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
    return <div className="notebook-controls" role="toolbar" dir={dir} aria-label={t('paper.name')}>
        <label>{t('paper.size')} <select aria-label={t('paper.size')} disabled={readOnly} value={paper.size}
            onChange={event => changePaper({ ...paper, size: event.currentTarget.value as PaperSize })}>
            <option value="letter">{t('paper.letter')}</option><option value="a4">{t('paper.a4')}</option><option value="legal">{t('paper.legal')}</option>
        </select></label>
        <button type="button" disabled={readOnly} aria-label={t('paper.rotate')} data-tooltip={t('paper.rotate')}
            onClick={() => changePaper({ ...paper, orientation: paper.orientation === 'portrait' ? 'landscape' : 'portrait' })}>
            {t(paper.orientation === 'portrait' ? 'paper.portrait' : 'paper.landscape')}</button>
        <label>{t('paper.ruling')} <select aria-label={t('paper.ruling')} disabled={readOnly} value={paper.ruling}
            onChange={event => changePaper({ ...paper, ruling: event.currentTarget.value as PaperRuling })}>
            <option value="lined">{t('paper.lined')}</option><option value="grid">{t('paper.grid')}</option>
            <option value="dotted">{t('paper.dotted')}</option><option value="blank">{t('paper.blank')}</option>
        </select></label>
        <button type="button" disabled={readOnly || paper.pageCount >= MAX_PAGES} onClick={addPage}
            aria-label={t('paper.addPage')} data-tooltip={t('paper.addPage')}>{t('paper.addPage')}</button>
        <button type="button" disabled={readOnly || paper.pageCount <= 1} onClick={deleteLastPage}
            aria-label={t('paper.deletePage')} data-tooltip={t('paper.deletePage')}>{t('paper.deletePage')}</button>
        <PagedNavigation page={page} count={paper.pageCount} inverted={inverted} thumbnailsOpen={thumbnailsOpen} t={t}
            jump={jump} toggleInversion={toggleInversion} toggleThumbnails={toggleThumbnails} />
    </div>;
}
