import type { PageDisplayList } from '../../platform/types';
import { paperPageSize, type NotebookPaper } from '../../utils/paper';
import type { SheetId } from '../model/ids';
import type { DisplayPdfWriter } from '../export/capturePdf';
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

async function contentOnPage(snapshot: NotebookExportSnapshot, sheets: readonly SheetId[], page: number, signal: AbortSignal): Promise<PageDisplayList> {
    const displayList: PageDisplayList = { page, items: [] };
    for (const sheet of sheets) {
        signal.throwIfAborted();
        const list = await snapshot.readSheetPage(sheet, page, signal);
        signal.throwIfAborted();
        if (list.page !== page) throw new Error('Notebook export returned the wrong physical page');
        for (const item of list.items) displayList.items.push(item);
    }
    return displayList;
}

/** Thumbnail consumers ask for one page, not the entire notebook. */
export async function notebookThumbnailPage(snapshot: NotebookExportSnapshot, page: number, signal: AbortSignal): Promise<NotebookExportPage> {
    const paper = { ...snapshot.paper };
    if (!Number.isInteger(page) || page < 0 || page >= paper.pageCount) throw new RangeError('Invalid notebook page');
    const { width, height } = paperPageSize(paper);
    const displayList = await contentOnPage(snapshot, [...snapshot.sheets], page, signal);
    return { width, height, paper: notebookPaperList(paper, page), displayList };
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
        const displayList = await contentOnPage(snapshot, sheets, page, signal);
        pages.push({ width, height, paper: { page, items: paperItems }, displayList });
    }
    return pages;
}

/** The host dynamically supplies the PDF writer only for an explicit export. */
export async function exportNotebookPdf(
    snapshot: NotebookExportSnapshot, sourcePath: string, writer: DisplayPdfWriter, signal: AbortSignal,
): Promise<Uint8Array> {
    const pages = await notebookExportPages(snapshot, signal);
    signal.throwIfAborted();
    return writer({ schema: 1, pages, notebookSource: { path: sourcePath } }, { signal });
}
