import { useCallback, useSyncExternalStore } from 'react';
import { isPdfRotating, subscribePdfRotating } from '../utils/pdfRotating';
import { RotateCcw, RotateCw } from './icons';

interface Props {
    path: string;
    /** Zero-based physical page. */
    page: number;
    onRotate: (delta: number, pageIndex?: number) => void;
    disabledReason?: string;
}

/** The store survives the document-session replacement after a real disk turn. */
export default function PdfTiledRotateControls({ path, page, onRotate, disabledReason }: Props) {
    const snapshot = useCallback(() => isPdfRotating(path), [path]);
    const rotating = useSyncExternalStore(subscribePdfRotating, snapshot);
    const buttonClass = rotating ? 'pdf-viewer-rotate-btn is-busy' : 'pdf-viewer-rotate-btn';
    return <>
        <button className={buttonClass} aria-busy={rotating} disabled={!!disabledReason} aria-label="Rotate the document left"
            data-tooltip={disabledReason ?? 'Rotate left ([) — hold ⌥ for this page only'}
            onClick={event => onRotate(-90, event.altKey ? page : undefined)}><RotateCcw size={15} className="pdf-viewer-rotate-ccw" /></button>
        <button className={buttonClass} aria-busy={rotating} disabled={!!disabledReason} aria-label="Rotate the document right"
            data-tooltip={disabledReason ?? 'Rotate right (]) — hold ⌥ for this page only'}
            onClick={event => onRotate(90, event.altKey ? page : undefined)}><RotateCw size={15} /></button>
    </>;
}
