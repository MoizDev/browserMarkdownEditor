import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Rect, ViewState } from '../platform/types';
import type { PageStack } from '../platform/render';
import { pageAt } from '../platform/render';
import type { PdfTiledDocumentSession } from '../pdf/session/documentSession';
import type { PdfPoolDocument } from '../pdf/pool/types';
import { pdfPoolTextSource } from '../pdf/text/poolSource';
import { getPdfFontEpoch, subscribePdfFontEpoch } from '../pdf/fonts/profiles';
import { retainPdfTextReaderVisibility, sessionPdfTextReader } from '../pdf/text/sessionReader';
import { PdfSelectionGeometryCache } from '../pdf/text/selectionCache';
import type { PdfSelection } from '../pdf/text/selection';
import { PdfTiledFindHighlights } from '../pdf/overlay/textFind';
import { pdfTextHighlightDefinition } from '../pdf/overlay/textHighlightDefinition';
import type { PdfHighlightPalette } from '../pdf/overlay/textHighlight';
import PdfFindBar from './PdfFindBar';
import type { PdfFindBarHandle, PdfFindStart } from './PdfFindBar';
import type { PdfFindHit } from '../utils/pdfFind';
import type { PdfFindMemory } from '../utils/pdfFindHighlight';

export interface PdfTiledFindOptions {
    session: PdfTiledDocumentSession;
    document: PdfPoolDocument;
    stack: Readonly<PageStack>;
    isVisible: boolean;
    isFocused: boolean;
    initialPage: number;
    memory: PdfFindMemory;
    palette: PdfHighlightPalette;
    selection: PdfSelection | null;
    selectedText(): string;
    readingPosition(): PdfFindStart;
    reveal(page: number, box: Readonly<Rect>): void;
    /** Record search navigation, then animate to the approximate glyph over
     * 150ms (instant for reduced motion). Return that navigation revision. */
    beginReveal?(page: number, box: Readonly<Rect>): number;
    /** After animation, correct only when revision is unchanged and glyph is outside view. */
    correctReveal?(page: number, box: Readonly<Rect>, revision: number): void;
    closeFind(hit?: PdfFindHit): void;
    notify(message: string): void;
}
interface FindResource {
    session: PdfTiledDocumentSession;
    document: PdfPoolDocument;
    reader: ReturnType<typeof sessionPdfTextReader>;
    geometry: PdfSelectionGeometryCache;
    layer: ReturnType<typeof pdfTextHighlightDefinition>;
    highlights: PdfTiledFindHighlights;
}

/** The viewer mounts the returned chrome layer after its page layer and calls
 * onView from the same overlay frame that positions links and the mirror. */
export function usePdfTiledFind(options: PdfTiledFindOptions) {
    const live = useRef(options), find = useRef<PdfFindBarHandle>(null);
    useLayoutEffect(() => { live.current = options; });
    const { session, document } = options;
    const subscribeEpoch = useCallback((listener: () => void) => subscribePdfFontEpoch(document.docKey, listener), [document.docKey]);
    const readEpoch = useCallback(() => getPdfFontEpoch(document.docKey), [document.docKey]);
    const fontEpoch = useSyncExternalStore(subscribeEpoch, readEpoch, readEpoch);
    const readerVisibility = useRef<ReturnType<typeof retainPdfTextReaderVisibility> | undefined>(undefined);
    const [stored, setStored] = useState<FindResource | null>(null);
    const resource = stored?.session === session && stored.document === document ? stored : null;
    useEffect(() => {
        const source = pdfPoolTextSource(document);
        const reader = sessionPdfTextReader(session, source, live.current.initialPage);
        const geometry = new PdfSelectionGeometryCache(document);
        const layer = pdfTextHighlightDefinition(live.current.palette);
        const highlights = new PdfTiledFindHighlights(geometry, {
            pageRect: page => live.current.stack.rects[page],
            reveal: (page, box) => live.current.reveal(page, box),
            approximate: async (hit, signal) => {
                const page = await reader.getPage(hit.page, signal, 0);
                const interval = page.intervals.find(item => !item.syntheticLF && item.to > hit.from && item.from < hit.to);
                return interval ? { x: interval.transform[4] ?? 0, y: (interval.transform[5] ?? 0) - interval.height,
                    width: interval.width, height: interval.height } : null;
            },
            beginReveal: (page, box) => live.current.beginReveal && live.current.correctReveal ? live.current.beginReveal(page, box) : null,
            correctReveal: (page, box, revision) => live.current.correctReveal?.(page, box, revision),
            publish: rects => layer.setRects(rects),
            error: error => live.current.notify(error instanceof Error ? error.message : 'PDF text highlights are unavailable.'),
        });
        setStored({ session, document, reader, geometry, layer, highlights });
        return () => { highlights.dispose(); geometry.dispose(); };
    }, [session, document]);
    useLayoutEffect(() => {
        if (!resource) return;
        const lease = retainPdfTextReaderVisibility(resource.reader, live.current.isVisible);
        readerVisibility.current = lease;
        return () => { if (readerVisibility.current === lease) readerVisibility.current = undefined; lease.release(); };
    }, [resource]);
    useLayoutEffect(() => {
        if (!resource) return;
        readerVisibility.current?.setVisible(options.isVisible);
        resource.geometry.setVisible(options.isVisible);
        resource.highlights.setVisible(options.isVisible);
    }, [resource, options.isVisible]);
    useLayoutEffect(() => {
        if (!resource) return;
        find.current?.cancelReveal();
        resource.highlights.setFind([], undefined);
        resource.highlights.setSelection(null);
    }, [resource, fontEpoch]);
    const engine = useMemo(() => {
        if (!resource) return undefined;
        // The bar uses engine identity to discard hits and restart the current query.
        const epoch = fontEpoch, current = resource.reader.findEngine;
        return { ...current, search: (...args: Parameters<typeof current.search>) => {
            if (readEpoch() !== epoch) throw new DOMException('Stale PDF find', 'AbortError');
            return current.search(...args);
        } };
    }, [resource, fontEpoch, readEpoch]);
    useEffect(() => { resource?.layer.setPalette(options.palette); }, [resource, options.palette]);
    useEffect(() => { resource?.highlights.setSelection(options.selection); }, [resource, options.selection]);
    const onView = useCallback((view: ViewState) => {
        if (!resource) return;
        const stack = live.current.stack, pages: number[] = [];
        const top = view.camera.y, bottom = top + view.viewport.height / view.camera.z;
        for (let page = Math.max(0, pageAt(stack, top)); page < stack.rects.length; page++) {
            if (stack.rects[page].y >= bottom) break;
            pages.push(page);
        }
        resource.highlights.setWindow(pages, view.camera.z);
    }, [resource]);
    const bar = resource && <PdfFindBar ref={find} engine={engine} memory={options.memory}
        isVisible={options.isVisible} isActive={options.isFocused}
        selectedText={() => live.current.selectedText()} readingPosition={() => live.current.readingPosition()}
        atOrAfter={(hit, start, signal) => resource.highlights.atOrAfter(hit, start, signal)}
        reveal={(hit, signal) => resource.highlights.reveal(hit, signal)}
        publish={(hits, current) => resource.highlights.setFind(hits, current)}
        close={hit => live.current.closeFind(hit)} onNotify={message => live.current.notify(message)} />;
    return { reader: resource?.reader, geometry: resource?.geometry, layer: resource?.layer.definition, find, bar, onView };
}
