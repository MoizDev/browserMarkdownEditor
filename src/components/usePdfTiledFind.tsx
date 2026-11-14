import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Rect, ViewState } from '../platform/types';
import type { PageStack } from '../platform/render';
import { pageAt } from '../platform/render';
import type { PdfTiledDocumentSession } from '../pdf/session/documentSession';
import type { PdfPoolDocument } from '../pdf/pool/types';
import { pdfPoolTextSource } from '../pdf/text/poolSource';
import { sessionPdfTextReader } from '../pdf/text/sessionReader';
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
    closeFind(hit?: PdfFindHit): void;
    notify(message: string): void;
}

/** The viewer mounts the returned chrome layer after its page layer and calls
 * onView from the same overlay frame that positions links and the mirror. */
export function usePdfTiledFind(options: PdfTiledFindOptions) {
    const live = useRef(options); live.current = options;
    const find = useRef<PdfFindBarHandle>(null);
    const { session, document } = options;
    const resource = useMemo(() => {
        const source = pdfPoolTextSource(document);
        const reader = sessionPdfTextReader(session, source, live.current.initialPage);
        const geometry = new PdfSelectionGeometryCache(document);
        const layer = pdfTextHighlightDefinition(live.current.palette);
        const highlights = new PdfTiledFindHighlights(geometry, {
            pageRect: page => live.current.stack.rects[page],
            reveal: (page, box) => live.current.reveal(page, box),
            publish: rects => layer.setRects(rects),
            error: error => live.current.notify(error instanceof Error ? error.message : 'PDF text highlights are unavailable.'),
        });
        return { reader, geometry, layer, highlights, lease: 0 };
    }, [session, document]);
    // StrictMode replays effects on the same resource; a real unmount does not
    // keep its geometry or pending work after the next microtask.
    useEffect(() => {
        const lease = ++resource.lease;
        return () => queueMicrotask(() => {
            if (resource.lease !== lease) return;
            resource.highlights.dispose(); resource.geometry.dispose();
        });
    }, [resource]);
    useLayoutEffect(() => {
        resource.reader.setVisible(options.isVisible);
        resource.geometry.setVisible(options.isVisible);
        resource.highlights.setVisible(options.isVisible);
    }, [resource, options.isVisible]);
    useEffect(() => { resource.layer.setPalette(options.palette); }, [resource, options.palette]);
    useEffect(() => { resource.highlights.setSelection(options.selection); }, [resource, options.selection]);
    const onView = useCallback((view: ViewState) => {
        const stack = live.current.stack, pages: number[] = [];
        const top = view.camera.y, bottom = top + view.viewport.height / view.camera.z;
        for (let page = Math.max(0, pageAt(stack, top)); page < stack.rects.length; page++) {
            if (stack.rects[page].y >= bottom) break;
            pages.push(page);
        }
        resource.highlights.setWindow(pages, view.camera.z);
    }, [resource]);
    const bar = <PdfFindBar ref={find} engine={resource.reader.findEngine} memory={options.memory}
        isVisible={options.isVisible} isActive={options.isFocused}
        selectedText={() => live.current.selectedText()} readingPosition={() => live.current.readingPosition()}
        atOrAfter={(hit, start, signal) => resource.highlights.atOrAfter(hit, start, signal)}
        reveal={(hit, signal) => resource.highlights.reveal(hit, signal)}
        publish={(hits, current) => resource.highlights.setFind(hits, current)}
        close={hit => live.current.closeFind(hit)} onNotify={message => live.current.notify(message)} />;
    return { reader: resource.reader, geometry: resource.geometry, layer: resource.layer.definition, find, bar, onView };
}
