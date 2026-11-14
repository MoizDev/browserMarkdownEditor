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
export interface NotebookPdfStream {
    append(page: NotebookExportPage, signal: AbortSignal): Promise<void>;
    finish(signal: AbortSignal): Promise<Uint8Array>;
    cancel(): void | Promise<void>;
}
export interface NotebookPdfStreamWriter {
    open(options: { readonly sourcePath: string; readonly pageCount: number }, signal: AbortSignal): Promise<NotebookPdfStream>;
}

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

/** A physical page is handed off before the next one is built, including every sheet. */
export async function streamNotebookPdf(snapshot: NotebookExportSnapshot, sourcePath: string,
    writer: NotebookPdfStreamWriter, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const paper = { ...snapshot.paper }, sheets = [...snapshot.sheets];
    if (!Number.isSafeInteger(paper.pageCount) || paper.pageCount < 1) throw new RangeError('Invalid notebook page count');
    const size = paperPageSize(paper), paperItems = notebookPaperList(paper, 0).items;
    const output = await writer.open({ sourcePath, pageCount: paper.pageCount }, signal);
    let complete = false;
    try {
        for (let page = 0; page < paper.pageCount; page++) {
            signal.throwIfAborted();
            const displayList = await contentOnPage(snapshot, sheets, page, signal);
            await output.append({ ...size, paper: { page, items: paperItems }, displayList }, signal);
        }
        signal.throwIfAborted();
        const bytes = await output.finish(signal);
        signal.throwIfAborted();
        complete = true;
        return bytes;
    } finally { if (!complete) await output.cancel(); }
}
