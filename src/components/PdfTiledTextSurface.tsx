import React, { useEffect, useRef, useState } from 'react';
import PdfReadingText from './PdfReadingText';
import type { PdfTiledTextSurfaceProps } from './PdfTiledTextSurface.types';
import { usePdfTiledTextReader } from './usePdfTiledTextReader';
import { tiledOriginalToText } from '../pdf/text/viewMapping';
import type { PdfViewPos } from '../utils/pdfViewState';
import type { PdfTextAnchor, PdfTextTypography } from '../utils/pdfReadingText';
import { loadChunk } from '../platform/chunkLoad';

const DEFAULT_TYPOGRAPHY: PdfTextTypography = { family: 'serif', size: 18, leading: 1.6, measure: 'comfortable', margins: 'medium', theme: 'follow-app' };

/** A Text pane borrows the App session's PDFium reader; it never opens a
 * second engine or projects raw page arrays on the main thread. */
export default function PdfTiledTextSurface({ source, reading, filePath, findMemory, checkpoint, anchor,
    expectedPageDigest, sameSchema, restorationNotice, isVisible, isFocused, onReader,
    onShowOriginalPage, onShowOriginal, onLocation, onTextQuality }: PdfTiledTextSurfaceProps) {
    const readingEpoch = reading?.identity.vaultEpoch, readingDocument = reading?.identity.documentId;
    useEffect(() => {
        const session = source.session, document = source.document.poolDocument, token = session.token;
        const current = () => session.isCurrent() && !document.closed && document.token.vaultEpoch === token.vaultEpoch &&
            document.token.documentId === token.documentId && document.token.bytesGeneration === token.bytesGeneration &&
            document.token.session === token.session && (readingEpoch === undefined || (readingEpoch === token.vaultEpoch && readingDocument === token.documentId));
        document.setVisible(isVisible && current());
        return () => document.setVisible(false);
    }, [source, readingEpoch, readingDocument, isVisible]);
    useEffect(() => {
        if (!isVisible || !isFocused) return;
        const session = source.session, document = source.document.poolDocument, token = session.token;
        let cancelled = false, release: (() => void) | undefined;
        void loadChunk(() => import('../pdf/session/startup')).then(({ retainPdfFocus }) => {
            if (cancelled || !session.isCurrent() || document.closed || document.token.vaultEpoch !== token.vaultEpoch ||
                document.token.documentId !== token.documentId || document.token.bytesGeneration !== token.bytesGeneration ||
                document.token.session !== token.session || (readingEpoch !== undefined && (readingEpoch !== token.vaultEpoch || readingDocument !== token.documentId))) return;
            const lease = retainPdfFocus(token.documentId);
            lease.setFocused(true); release = () => lease.dispose();
        });
        return () => { cancelled = true; release?.(); };
    }, [source, readingEpoch, readingDocument, isVisible, isFocused]);
    const reader = usePdfTiledTextReader(source.session, source.document.poolDocument, checkpoint.page, isVisible);
    const notify = useRef(onReader);
    useEffect(() => { notify.current = onReader; }, [onReader]);
    useEffect(() => {
        if (!reader) return;
        notify.current?.(reader);
        return () => notify.current?.(undefined);
    }, [reader]);
    const [mapped, setMapped] = useState<{ reader: NonNullable<typeof reader>; anchor: PdfTextAnchor }>();
    // The mapping reads only the page and offset of the checkpoint, so those primitives are its inputs.
    const { page: checkpointPage, offset: checkpointOffset, zoom: checkpointZoom } = checkpoint;
    useEffect(() => {
        if (!reader || anchor) return;
        const cancel = new AbortController();
        const position: PdfViewPos = { page: checkpointPage, offset: checkpointOffset, zoom: checkpointZoom };
        void tiledOriginalToText(reader, position, cancel.signal).catch((): PdfTextAnchor => ({
            physicalPageIndex: checkpointPage, offsetUTF16: 0, affinity: 'after', quote: '', before: '', after: '',
        })).then(next => { if (!cancel.signal.aborted) setMapped({ reader, anchor: next }); });
        return () => cancel.abort();
    }, [reader, anchor, checkpointPage, checkpointOffset, checkpointZoom]);
    const initial = anchor ?? (mapped && mapped.reader === reader ? mapped.anchor : undefined);
    if (!reader || !initial) return <div className="pdf-pane-message is-waiting">Opening extracted text…</div>;
    return <PdfReadingText filePath={filePath} controller={reader} isFocused={isFocused} isVisible={isVisible}
        anchor={initial} expectedPageDigest={expectedPageDigest} sameSchema={sameSchema} restorationNotice={restorationNotice}
        findMemory={findMemory} onShowOriginalPage={onShowOriginalPage} onShowOriginal={onShowOriginal}
        onLocation={onLocation} onTextQuality={onTextQuality} emphasisEnabled={false}
        typography={reading?.typography ?? DEFAULT_TYPOGRAPHY} onTypographyChange={reading?.onTypographyChange} />;
}
