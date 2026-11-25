import type { PageDisplayList, PageGeometry } from '../../platform/types';
import type { SheetId } from '../model/ids';
import type { IncrementalPdfPage } from '../export/incrementalPdf';
import type { EmittedInk } from '../../pdf/writing/protocol';

/** The source is revision-pinned; the reader returns page-local, clipped print-light ink. */
export interface PdfInkSnapshot {
    readonly pages: readonly PageGeometry[];
    readonly sheets: readonly SheetId[];
    readSheetPage(sheet: SheetId, page: number, signal: AbortSignal): Promise<PageDisplayList>;
    writeSheetPage(sheet: SheetId, page: number, sink: IncrementalPdfPage, signal: AbortSignal): Promise<void>;
}

/** Passes a page's writes through, telling `paint` when one can mark the page: a filled or stroked path, or a picture.
 * Groups (the page clip, isolation, transforms) and unpainted paths mark nothing. */
function paintWatch(page: IncrementalPdfPage, paint: () => void): IncrementalPdfPage {
    return {
        beginGroup: (group, signal) => page.beginGroup(group, signal),
        endGroup: signal => page.endGroup(signal),
        beginPath: (path, signal) => { if (path.fill || path.stroke) paint(); return page.beginPath(path, signal); },
        pathCommands: (commands, signal) => page.pathCommands(commands, signal),
        endPath: signal => page.endPath(signal),
        image: (item, signal) => { paint(); return page.image(item, signal); },
    };
}

/** The writer consumes each contour chunk before the producer pulls the next one.
 * A logical text/ink path remains open across chunks and logical sheets retain their order.
 * Only pages that something paints are placed: the stamper turns every placed page's (possibly empty) ink into Forms
 * and regenerates that page's content, so every save paid for empty ink on every page (measured: one stroke on a
 * 120-page, 109 KB PDF saved as 445 KB, and as 353 KB once the 119 pages it does not touch were left unplaced).
 * An unplaced page keeps the original's content, which is what the page shows either way. */
export async function emitStreamingPdfInk(snapshot: PdfInkSnapshot, revision: number, signal: AbortSignal): Promise<EmittedInk> {
    const { createIncrementalPdfWriter } = await import('../../pdf/writing/incrementalClient');
    let result: EmittedInk | undefined;
    const painted: boolean[] = snapshot.pages.map(() => false);
    const writer = createIncrementalPdfWriter({ onFinish: async (emitted, active) => {
        active.throwIfAborted();
        if (emitted.revision !== revision || emitted.pages.length !== snapshot.pages.length || emitted.hashes.length !== snapshot.pages.length) {
            throw new Error('Incremental PDF ink returned a different revision or page count');
        }
        const pages = snapshot.pages.map((geometry, index) => {
            const actual = emitted.pages[index], hash = emitted.hashes[index];
            if (geometry.index !== index || actual.index !== index || actual.width !== geometry.width || actual.height !== geometry.height
                || !/^[0-9a-f]{64}$/u.test(hash)) throw new Error('Incremental PDF ink returned different physical pages');
            return { sourcePage: index, inkPage: index, width: geometry.width, height: geometry.height, hash };
        }).filter(page => painted[page.sourcePage]);
        result = { schema: 1, pdf: new Blob([emitted.bytes.slice().buffer], { type: 'application/pdf' }), pages };
        return emitted.bytes;
    } });
    const output = await writer.open({ revision, pageCount: snapshot.pages.length }, signal);
    let complete = false;
    try {
        for (let index = 0; index < snapshot.pages.length; index++) {
            signal.throwIfAborted();
            const geometry = snapshot.pages[index];
            if (geometry.index !== index || !(geometry.width > 0 && geometry.height > 0)
                || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height)) throw new Error('Invalid PDF ink page geometry');
            const page = await output.beginPage({ index, width: geometry.width, height: geometry.height }, signal);
            const watched = paintWatch(page, () => { painted[index] = true; });
            for (const sheet of snapshot.sheets) {
                signal.throwIfAborted();
                await snapshot.writeSheetPage(sheet, index, watched, signal);
            }
            await output.endPage(page, signal);
        }
        await output.finish(signal);
        signal.throwIfAborted();
        if (!result) throw new Error('Incremental PDF ink did not finish');
        complete = true;
        return result;
    } finally { if (!complete) await output.cancel(); }
}
