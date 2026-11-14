import { PDF_COPY_RESTRICTED, PDF_COPY_UNKNOWN, PDF_ENCRYPTED_READ_ONLY, PDF_XFA_UNSUPPORTED, type PdfCapabilities } from '../utils/pdfCapabilities';
import './PdfCapabilitiesNotice.css';

/** Persistent disclosure: a blank XFA page must not look like a clean rendering. */
export default function PdfCapabilitiesNotice({ capabilities }: { capabilities: PdfCapabilities }) {
    const messages: string[] = [];
    if (capabilities.xfa === true) messages.push(capabilities.formType === 'xfa-full'
        ? 'This PDF uses XFA forms, which are unsupported. Pages may be blank or incomplete.'
        : capabilities.formType === 'xfa-foreground'
            ? 'This PDF uses XFA foreground forms, which are unsupported. Fields or pages may be incomplete.' : PDF_XFA_UNSUPPORTED);
    else if (capabilities.xfa === 'unknown') messages.push('XFA status is unknown; some form content may be unavailable.');
    if (capabilities.encrypted === true) messages.push(PDF_ENCRYPTED_READ_ONLY);
    if (capabilities.encrypted === 'unknown') messages.push('PDF encryption status could not be established.');
    if (capabilities.copy === false) messages.push(PDF_COPY_RESTRICTED);
    if (capabilities.copy === 'unknown') messages.push(PDF_COPY_UNKNOWN);
    if (capabilities.forms === true) messages.push('Form fields are not editable. Saved appearances are shown where supported; missing appearances may be unavailable.');
    else if (capabilities.forms === 'unknown') messages.push('Form-field availability could not be established.');
    if (capabilities.signed === true) messages.push('This PDF contains signatures; rewriting it can invalidate them.');
    if (capabilities.repairStatus === 'repaired') messages.push('This PDF required repair for viewing; do not overwrite the original with the repair.');
    else if (capabilities.repairStatus === 'unknown') messages.push('Whether this PDF required repair is unknown.');
    const active = capabilities.javascript === true || capabilities.actions === 'present' ? 'This PDF contains scripts or actions.'
        : capabilities.javascript === 'unknown' || !capabilities.actions || capabilities.actions === 'unknown'
            ? 'Whether this PDF contains scripts or actions is unknown.' : 'No PDF scripts or actions were reported.';
    messages.push(`${active} Scripts, form submission, embedded-file launches and remote resources do not run in this viewer.`);
    return <div className="pdf-capabilities-notice" role="status" aria-label="PDF feature limitations">
        <strong>PDF feature limitations</strong>
        {messages.map(message => <div key={message}>{message}</div>)}
    </div>;
}
