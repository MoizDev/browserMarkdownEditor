import { RotateCcw, RotateCw } from './icons';

interface Props {
    /** Zero-based physical page. */
    page: number;
    onRotate: (delta: number, pageIndex?: number) => void;
    disabledReason?: string;
}

/** The page turns at the press (utils/pdfRotationStandIn.ts), so the buttons need no busy state of their own. */
export default function PdfTiledRotateControls({ page, onRotate, disabledReason }: Props) {
    return <>
        <button className="pdf-viewer-rotate-btn" disabled={!!disabledReason} aria-label="Rotate the document left"
            data-tooltip={disabledReason ?? 'Rotate left ([) — hold ⌥ for this page only'}
            onClick={event => onRotate(-90, event.altKey ? page : undefined)}><RotateCcw size={15} /></button>
        <button className="pdf-viewer-rotate-btn" disabled={!!disabledReason} aria-label="Rotate the document right"
            data-tooltip={disabledReason ?? 'Rotate right (]) — hold ⌥ for this page only'}
            onClick={event => onRotate(90, event.altKey ? page : undefined)}><RotateCw size={15} /></button>
    </>;
}
