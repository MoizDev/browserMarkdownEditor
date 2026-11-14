import type { PageDisplayList } from '../../platform/types';
import { paperPageSize, type NotebookPaper } from '../../utils/paper';
import type { SheetId } from '../model/ids';
import { notebookPaperList } from './notebookPaper';

export interface NotebookExportPage {
    readonly width: number;
    readonly height: number;
    readonly paper: PageDisplayList;
    readonly displayList: PageDisplayList;
}

/** The caller pins a document revision and its media before supplying this reader. */
export interface NotebookExportSnapshot {
    readonly paper: Readonly<NotebookPaper>;
    readonly sheets: readonly SheetId[];
    readSheetPage(sheet: SheetId, page: number, signal: AbortSignal): Promise<PageDisplayList>;
}

/** Build print-light, page-local output in physical-page and logical-sheet order. */
export async function notebookExportPages(snapshot: NotebookExportSnapshot, signal: AbortSignal): Promise<NotebookExportPage[]> {
    const paper = { ...snapshot.paper };
    const sheets = [...snapshot.sheets];
    const { width, height } = paperPageSize(paper);
    const pages: NotebookExportPage[] = [];
    // Every sheet of paper is identical; keep one immutable geometry shared by the pages.
    const paperItems = notebookPaperList(paper, 0).items;
    for (let page = 0; page < paper.pageCount; page++) {
        signal.throwIfAborted();
        const displayList: PageDisplayList = { page, items: [] };
        for (const sheet of sheets) {
            const list = await snapshot.readSheetPage(sheet, page, signal);
            signal.throwIfAborted();
            if (list.page !== page) throw new Error('Notebook export returned the wrong physical page');
            for (const item of list.items) displayList.items.push(item);
        }
        pages.push({ width, height, paper: { page, items: paperItems }, displayList });
    }
    return pages;
}
