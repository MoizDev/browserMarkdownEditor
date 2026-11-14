import React, { useEffect, useRef, useState } from 'react';
import PdfReadingText from './PdfReadingText';
import type { PdfTiledTextSurfaceProps } from './PdfTiledTextSurface.types';
import { usePdfTiledTextReader } from './usePdfTiledTextReader';
import { tiledOriginalToText } from '../pdf/text/viewMapping';
import type { PdfTextAnchor, PdfTextTypography } from '../utils/pdfReadingText';

const DEFAULT_TYPOGRAPHY: PdfTextTypography = { family: 'serif', size: 18, leading: 1.6, measure: 'comfortable', margins: 'medium', theme: 'follow-app' };

/** A Text pane borrows the App session's PDFium reader; it never opens a
 * second engine or projects raw page arrays on the main thread. */
export default function PdfTiledTextSurface({ source, reading, filePath, findMemory, checkpoint, anchor,
    expectedPageDigest, sameSchema, restorationNotice, isVisible, isFocused, onReader,
    onShowOriginalPage, onShowOriginal, onLocation, onTextQuality }: PdfTiledTextSurfaceProps) {
    const reader = usePdfTiledTextReader(source.session, source.document.poolDocument, checkpoint.page, isVisible);
    const notify = useRef(onReader);
    useEffect(() => { notify.current = onReader; }, [onReader]);
    useEffect(() => {
        if (!reader) return;
        notify.current?.(reader);
        return () => notify.current?.(undefined);
    }, [reader]);
    const [mapped, setMapped] = useState<{ reader: NonNullable<typeof reader>; anchor: PdfTextAnchor }>();
    useEffect(() => {
        if (!reader || anchor) return;
        const cancel = new AbortController();
        void tiledOriginalToText(reader, checkpoint, cancel.signal).catch((): PdfTextAnchor => ({
            physicalPageIndex: checkpoint.page, offsetUTF16: 0, affinity: 'after', quote: '', before: '', after: '',
        })).then(next => { if (!cancel.signal.aborted) setMapped({ reader, anchor: next }); });
        return () => cancel.abort();
    }, [reader, anchor, checkpoint.page, checkpoint.offset, checkpoint.zoom]);
    const initial = anchor ?? (mapped?.reader === reader ? mapped.anchor : undefined);
    if (!reader || !initial) return <div className="pdf-pane-message">Opening extracted text…</div>;
    return <PdfReadingText filePath={filePath} controller={reader} isFocused={isFocused} isVisible={isVisible}
        anchor={initial} expectedPageDigest={expectedPageDigest} sameSchema={sameSchema} restorationNotice={restorationNotice}
        findMemory={findMemory} onShowOriginalPage={onShowOriginalPage} onShowOriginal={onShowOriginal}
        onLocation={onLocation} onTextQuality={onTextQuality} emphasisEnabled={false}
        typography={reading?.typography ?? DEFAULT_TYPOGRAPHY} onTypographyChange={reading?.onTypographyChange} />;
}
