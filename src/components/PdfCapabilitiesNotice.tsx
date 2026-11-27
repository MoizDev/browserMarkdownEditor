import { PDF_COPY_RESTRICTED, PDF_COPY_UNKNOWN, PDF_ENCRYPTED_READ_ONLY, PDF_PRINT_LOW_QUALITY_ONLY, PDF_PRINT_RESTRICTED, PDF_PRINT_UNKNOWN, PDF_XFA_UNSUPPORTED, type PdfCapabilities } from '../utils/pdfCapabilities';
import { useEffect, useRef, useState } from 'react';
import './PdfCapabilitiesNotice.css';

export default function PdfCapabilitiesNotice({ capabilities, nativeFontPolicy = false }: { capabilities: PdfCapabilities; nativeFontPolicy?: boolean }) {
    const messages: string[] = [];
    if (nativeFontPolicy) messages.push('When non-embedded fonts are substituted, this reader uses bundled Noto faces where supported. Ambiguous Chinese uses Simplified Chinese (SC); a known character set takes precedence over a conflicting language hint.');
    if (capabilities.xfa === true) messages.push(capabilities.formType === 'xfa-full'
        ? 'This PDF uses XFA forms, which are unsupported. Pages may be blank or incomplete.'
        : capabilities.formType === 'xfa-foreground'
            ? 'This PDF uses XFA foreground forms, which are unsupported. Fields or pages may be incomplete.' : PDF_XFA_UNSUPPORTED);
    else if (capabilities.xfa === 'unknown') messages.push('XFA status is unknown; some form content may be unavailable.');
    if (capabilities.encrypted === true) messages.push(PDF_ENCRYPTED_READ_ONLY);
    if (capabilities.encrypted === 'unknown') messages.push('PDF encryption status could not be established.');
    if (capabilities.copy === false) messages.push(PDF_COPY_RESTRICTED);
    if (capabilities.copy === 'unknown') messages.push(PDF_COPY_UNKNOWN);
    if (capabilities.print === false) messages.push(PDF_PRINT_RESTRICTED);
    else if (capabilities.print === 'unknown') messages.push(PDF_PRINT_UNKNOWN);
    else if (capabilities.print === true && capabilities.printHighQuality === false) messages.push(PDF_PRINT_LOW_QUALITY_ONLY);
    else if (capabilities.print === true && capabilities.printHighQuality !== true) messages.push('Printing is permitted; the quality restriction is unknown.');
    else if (capabilities.print === true) messages.push('Printing is permitted.');
    if (capabilities.forms === true) messages.push('Form fields are not editable. Saved appearances are shown where supported; missing appearances may be unavailable.');
    else if (capabilities.forms === 'unknown') messages.push('Form-field availability could not be established.');
    if (capabilities.signed === true) messages.push('This PDF contains signatures; rewriting it can invalidate them.');
    if (capabilities.repairStatus === 'repaired') messages.push('This PDF required repair for viewing; do not overwrite the original with the repair.');
    else if (capabilities.repairStatus === 'unknown') messages.push('Whether this PDF required repair is unknown.');
    const active = capabilities.javascript === true || capabilities.actions === 'present' ? 'This PDF contains scripts or actions.'
        : capabilities.javascript === 'unknown' || !capabilities.actions || capabilities.actions === 'unknown'
            ? 'Whether this PDF contains scripts or actions is unknown.' : 'No PDF scripts or actions were reported.';
    messages.push(`${active} Scripts, form submission, embedded-file launches and remote resources do not run in this viewer.`);
    return <CapabilitiesDisclosure messages={messages} />;
}

function CapabilitiesDisclosure({ messages }: { messages: string[] }) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
        const down = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
        window.addEventListener('keydown', key, true);
        window.addEventListener('pointerdown', down, true);
        return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', down, true); };
    }, [open]);
    return <div className="pdf-capabilities" ref={root}>
        <button type="button" className={`pdf-capabilities-toggle${open ? ' is-on' : ''}`} aria-expanded={open}
            aria-label="PDF feature limitations" data-tooltip={open ? undefined : 'PDF feature limitations'} onClick={() => setOpen(value => !value)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
            </svg>
        </button>
        {open && <div className="pdf-capabilities-notice" role="status">
            <strong>PDF feature limitations</strong>
            {messages.map(message => <div key={message}>{message}</div>)}
        </div>}
    </div>;
}
