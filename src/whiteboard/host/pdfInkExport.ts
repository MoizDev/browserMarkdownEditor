import type { PageDisplayList, PageGeometry } from '../../platform/types';
import type { SheetId } from '../model/ids';

export interface PdfInkPage {
    readonly sourcePage: number;
    readonly width: number;
    readonly height: number;
    readonly displayList: PageDisplayList;
}

/** The source is revision-pinned; the reader returns page-local, clipped print-light ink. */
export interface PdfInkSnapshot {
    readonly pages: readonly PageGeometry[];
    readonly sheets: readonly SheetId[];
    readSheetPage(sheet: SheetId, page: number, signal: AbortSignal): Promise<PageDisplayList>;
}

/** Preserve logical-sheet compositing order on each original physical PDF page. */
export async function pdfInkPages(snapshot: PdfInkSnapshot, signal: AbortSignal): Promise<PdfInkPage[]> {
    const pages = [...snapshot.pages], sheets = [...snapshot.sheets];
    const output: PdfInkPage[] = [];
    for (let i = 0; i < pages.length; i++) {
        signal.throwIfAborted();
        const geometry = pages[i];
        if (geometry.index !== i || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height)
            || geometry.width <= 0 || geometry.height <= 0) throw new Error('Invalid PDF page geometry');
        const displayList: PageDisplayList = { page: i, items: [] };
        for (const sheet of sheets) {
            const list = await snapshot.readSheetPage(sheet, i, signal);
            signal.throwIfAborted();
            if (list.page !== i) throw new Error('PDF ink export returned the wrong physical page');
            for (const item of list.items) displayList.items.push(item);
        }
        output.push({ sourcePage: i, width: geometry.width, height: geometry.height, displayList });
    }
    return output;
}
