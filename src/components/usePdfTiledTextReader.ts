import { useLayoutEffect, useRef, useState } from 'react';
import type { PdfTiledDocumentSession } from '../pdf/session/documentSession';
import type { PdfPoolDocument } from '../pdf/pool/types';
import { pdfPoolTextSource } from '../pdf/text/poolSource';
import { retainPdfTextReaderVisibility, sessionPdfTextReader } from '../pdf/text/sessionReader';
import type { PdfTextReader } from '../utils/pdfReadingText';

/** A Text surface borrows the same session reader/index as Original. */
export function usePdfTiledTextReader(session: PdfTiledDocumentSession | null, document: PdfPoolDocument | null,
    initialPage: number, isVisible: boolean): PdfTextReader | undefined {
    const latest = useRef({ initialPage, isVisible });
    useLayoutEffect(() => { latest.current = { initialPage, isVisible }; });
    const lease = useRef<ReturnType<typeof retainPdfTextReaderVisibility> | undefined>(undefined);
    const [stored, setStored] = useState<{ session: PdfTiledDocumentSession; document: PdfPoolDocument; reader: PdfTextReader }>();
    useLayoutEffect(() => {
        if (!session || !document) return;
        const reader = sessionPdfTextReader(session, pdfPoolTextSource(document), latest.current.initialPage);
        const owner = retainPdfTextReaderVisibility(reader, latest.current.isVisible);
        lease.current = owner;
        setStored({ session, document, reader });
        return () => { owner.release(); if (lease.current === owner) lease.current = undefined; };
    }, [session, document]);
    useLayoutEffect(() => { lease.current?.setVisible(isVisible); }, [isVisible, session, document]);
    return stored?.session === session && stored.document === document ? stored.reader : undefined;
}
