import type { ClassicPdfDiagnostic } from '../utils/pdfClassicHealth';
import './PdfRenderNotice.css';

interface PdfRenderNoticeProps {
    issue: ClassicPdfDiagnostic;
    page?: boolean;
    annotation?: boolean;
    onRetry?: () => void;
    retryDisabled?: boolean;
}
export default function PdfRenderNotice({ issue, page = false, annotation = false, onRetry, retryDisabled = false }: PdfRenderNoticeProps) {
    const delayed = issue.code === 'render-delayed';
    const message = delayed ? 'This PDF is taking longer than usual.'
        : issue.code === 'worker-startup-failed' ? 'The PDF renderer could not start.'
        : issue.code === 'worker-failed' ? 'The PDF renderer stopped.'
        : issue.pageIndex !== undefined ? `Page ${issue.pageIndex + 1} could not be rendered completely.`
        : 'This PDF could not be rendered completely.';
    return (
        <div className={`pdf-render-notice${page ? ' is-page' : ''}`} role={delayed ? 'status' : 'alert'} aria-label={delayed ? 'PDF rendering delayed' : 'PDF rendering incomplete'}
            onContextMenu={event => event.preventDefault()}>
            <div className="pdf-render-notice-copy">
                <strong>{message}</strong>
                <span>{delayed ? 'You can keep waiting. ' : ''}The original file is unchanged.{annotation ? ' Switch to View to try again.' : ''}</span>
                <code>{issue.code}</code>
            </div>
            {!annotation && onRetry && <button type="button" className="pdf-pane-action" onClick={onRetry} disabled={retryDisabled}>Try again</button>}
        </div>
    );
}
