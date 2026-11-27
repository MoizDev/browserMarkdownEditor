import type { PageDisplayList } from '../../platform/types';
import { paperPageSize, type NotebookPaper } from '../../utils/paper';
import type { SheetId } from '../model/ids';
import { notebookPaperList } from './notebookPaper';
import type { IncrementalPdfPage, IncrementalPdfWriter } from '../export/incrementalPdf';

export interface NotebookExportPage {
    readonly width: number;
    readonly height: number;
    readonly paper: PageDisplayList;
    readonly displayList: PageDisplayList;
}

export interface NotebookPdfStream {
    append(page: NotebookExportPage, signal: AbortSignal): Promise<void>;
    finish(signal: AbortSignal): Promise<Uint8Array>;
    cancel(): void | Promise<void>;
}
export interface NotebookPdfStreamWriter {
    open(options: { readonly sourcePath: string; readonly pageCount: number }, signal: AbortSignal): Promise<NotebookPdfStream>;
}

export interface NotebookExportSnapshot {
    readonly revision?: number;
    readonly paper: Readonly<NotebookPaper>;
    readonly sheets: readonly SheetId[];
    readSheetPage(sheet: SheetId, page: number, signal: AbortSignal): Promise<PageDisplayList>;
    writeSheetPage?(sheet: SheetId, page: number, sink: IncrementalPdfPage, signal: AbortSignal): Promise<void>;
}

export async function exportIncrementalNotebookPdf(snapshot: NotebookExportSnapshot, sourcePath: string,
    writer: IncrementalPdfWriter, signal: AbortSignal): Promise<Uint8Array> {
    const { revision, writeSheetPage } = snapshot, paper = { ...snapshot.paper }, sheets = [...snapshot.sheets];
    if (!Number.isSafeInteger(revision) || revision! < 0 || !writeSheetPage || !Number.isSafeInteger(paper.pageCount) || paper.pageCount < 1) {
        throw new Error('A revision-pinned incremental notebook source is required');
    }
    const output = await writer.open({ revision: revision!, pageCount: paper.pageCount, notebookSource: { path: sourcePath } }, signal);
    const size = paperPageSize(paper);
    let complete = false;
    try {
        for (let index = 0; index < paper.pageCount; index++) {
            signal.throwIfAborted();
            const page = await output.beginPage({ index, ...size }, signal);
            for (const item of notebookPaperList(paper, index).items) {
                if (item.kind !== 'path') throw new Error('Notebook paper contains unsupported incremental geometry');
                const { d, ...style } = item;
                await page.beginPath(style, signal);
                for (let at = 0; at < d.length; at += 1024) await page.pathCommands(d.slice(at, at + 1024), signal);
                await page.endPath(signal);
            }
            for (const sheet of sheets) await writeSheetPage(sheet, index, page, signal);
            await output.endPage(page, signal);
        }
        const bytes = await output.finish(signal);
        signal.throwIfAborted();
        complete = true;
        return bytes;
    } finally { if (!complete) await output.cancel(); }
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

export async function notebookThumbnailPage(snapshot: NotebookExportSnapshot, page: number, signal: AbortSignal): Promise<NotebookExportPage> {
    const paper = { ...snapshot.paper };
    if (!Number.isInteger(page) || page < 0 || page >= paper.pageCount) throw new RangeError('Invalid notebook page');
    const { width, height } = paperPageSize(paper);
    const displayList = await contentOnPage(snapshot, [...snapshot.sheets], page, signal);
    return { width, height, paper: notebookPaperList(paper, page), displayList };
}

function isIncrementalWriter(writer: NotebookPdfStreamWriter | IncrementalPdfWriter): writer is IncrementalPdfWriter {
    return 'kind' in writer && writer.kind === 'incremental-pdf';
}

export async function streamNotebookPdf(snapshot: NotebookExportSnapshot, sourcePath: string,
    writer: NotebookPdfStreamWriter | IncrementalPdfWriter, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (isIncrementalWriter(writer)) return exportIncrementalNotebookPdf(snapshot, sourcePath, writer, signal);
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
