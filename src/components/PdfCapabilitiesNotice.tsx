import { PDF_COPY_RESTRICTED, PDF_COPY_UNKNOWN, PDF_ENCRYPTED_READ_ONLY, type PdfCapabilities } from '../utils/pdfCapabilities';
import './PdfCapabilitiesNotice.css';

/** Static appearances are not an interactive PDF runtime. */
export default function PdfCapabilitiesNotice({ capabilities }: { capabilities: PdfCapabilities }) {
    const messages: string[] = [];
    if (capabilities.encrypted === true) messages.push(PDF_ENCRYPTED_READ_ONLY);
    if (capabilities.encrypted === 'unknown') messages.push('PDF encryption status could not be established.');
    if (capabilities.copy === false) messages.push(PDF_COPY_RESTRICTED);
    if (capabilities.copy === 'unknown') messages.push(PDF_COPY_UNKNOWN);
    if (capabilities.xfa === true) messages.push('XFA forms are unsupported; some pages or fields may be missing.');
    if (capabilities.forms === true) messages.push('Form fields cannot be edited. Saved appearances are shown where supported; XFA and missing appearances may be unavailable.');
    messages.push('PDF scripts, form submission and launch actions do not run in this viewer.');
    const limited = capabilities.encrypted !== false || capabilities.copy !== true || capabilities.xfa === true || capabilities.forms === true;
    return <details className="pdf-capabilities-notice" open={limited || undefined}>
        <summary>PDF {limited ? 'limitations' : 'features'}</summary>
        <div role="status">{messages.map(message => <div key={message}>{message}</div>)}</div>
    </details>;
}
