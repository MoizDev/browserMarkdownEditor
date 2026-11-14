import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Permission state is deliberately tri-state: an unavailable result is not
 * evidence that extraction or mutation is allowed. */
export interface PdfCapabilities {
    encrypted: boolean | 'unknown';
    copy: boolean | 'unknown';
    /** Native browser printing receives original bytes, not a quality-limited raster. */
    print?: boolean | 'unknown';
    printHighQuality?: boolean | 'unknown';
    forms: boolean | 'unknown';
    xfa: boolean | 'unknown';
    javascript: boolean | 'unknown';
    /** Separate authorities: an unlocked view is not permission to extract or rewrite it. */
    render?: boolean | 'unknown';
    capture?: boolean | 'unknown';
    write?: boolean | 'unknown';
    formType?: 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground' | 'unknown';
    actions?: 'present' | 'absent' | 'unknown';
    repairStatus?: 'clean' | 'repaired' | 'unknown';
    signed?: boolean | 'unknown';
}

const COPY_FLAG = 1 << 4;
const PRINT_FLAG = 1 << 2;
const PRINT_HIGH_QUALITY_FLAG = 1 << 11;
export const PDF_COPY_RESTRICTED = 'This PDF does not permit copying or text extraction.';
export const PDF_COPY_UNKNOWN = 'PDF copy permissions could not be established; text extraction is unavailable.';
export const PDF_PRINT_RESTRICTED = 'This PDF does not permit printing.';
export const PDF_PRINT_UNKNOWN = 'PDF print permissions could not be established; printing is unavailable.';
export const PDF_PRINT_LOW_QUALITY_ONLY = 'This PDF permits only low-quality printing; the browser handoff cannot enforce that restriction.';
export const PDF_ENCRYPTED_READ_ONLY = 'Encrypted PDFs are read-only; annotation and rotation are unavailable.';
export const PDF_XFA_UNSUPPORTED = 'XFA forms are unsupported; pages or fields may be missing or blank.';

function assertAllowed(value: boolean | 'unknown' | undefined, denied: string, unknown: string): void {
    if (value !== true) throw new Error(value === false ? denied : unknown);
}

/** Use at the operation boundary, not as a substitute for role/baseline checks. */
export function assertPdfRenderAllowed(policy: Pick<PdfCapabilities, 'render'>): void {
    assertAllowed(policy.render, 'This PDF cannot be rendered.', 'PDF rendering permission could not be established.');
}
export function assertPdfCaptureAllowed(policy: Pick<PdfCapabilities, 'capture'>): void {
    assertAllowed(policy.capture, 'This PDF cannot be captured because extraction is restricted or its pages may be incomplete.',
        'PDF capture permission or page completeness could not be established.');
}
export function assertPdfWriteAllowed(policy: Pick<PdfCapabilities, 'write'>): void {
    assertAllowed(policy.write, 'This PDF cannot be safely rewritten.', 'PDF write safety could not be established.');
}

export function assertPdfPrintAllowed(policy: Pick<PdfCapabilities, 'print' | 'printHighQuality'>): void {
    assertAllowed(policy.print, PDF_PRINT_RESTRICTED, PDF_PRINT_UNKNOWN);
    assertAllowed(policy.printHighQuality, PDF_PRINT_LOW_QUALITY_ONLY, PDF_PRINT_UNKNOWN);
}

export function assertPdfCopyAllowed(policy: Pick<PdfCapabilities, 'copy'>): void {
    if (policy.copy !== true) throw new Error(policy.copy === false ? PDF_COPY_RESTRICTED : PDF_COPY_UNKNOWN);
}

/** pdf.js exposes an array of permitted operations rather than /P itself. */
export async function classicPdfCapabilities(doc: PDFDocumentProxy): Promise<PdfCapabilities> {
    const [metadata, permissions] = await Promise.allSettled([doc.getMetadata(), doc.getPermissions()]);
    const info = metadata.status === 'fulfilled' ? metadata.value.info as Record<string, unknown> : undefined;
    const encrypted = info?.EncryptFilterName === null ? false
        : typeof info?.EncryptFilterName === 'string' ? true : 'unknown';
    const flag = (name: string): boolean | 'unknown' => typeof info?.[name] === 'boolean' ? info[name] as boolean : 'unknown';
    const copy = permissions.status !== 'fulfilled' ? 'unknown'
        : permissions.value === null ? encrypted === false ? true : 'unknown' : permissions.value.includes(COPY_FLAG);
    const forms = flag('IsAcroFormPresent'), xfa = flag('IsXFAPresent');
    return { encrypted, copy, forms, xfa, javascript: 'unknown', render: true,
        capture: copy === false || xfa === true ? false : copy === true && xfa === false ? true : 'unknown',
        write: encrypted === true || xfa === true ? false : 'unknown', actions: 'unknown', repairStatus: 'unknown', signed: 'unknown' };
}

/** Unknown native flags are displayed as unknown, never advertised as clean. */
export function tiledPdfCapabilities(info: { encrypted: boolean; permissions: number | null; hasForms: boolean;
    formType?: PdfCapabilities['formType']; javascript?: 'present' | 'absent' | 'unknown';
    actions?: PdfCapabilities['actions']; repairStatus?: PdfCapabilities['repairStatus']; signatureCount?: number }): PdfCapabilities {
    const formType = info.formType ?? 'unknown';
    const xfa = formType === 'xfa-full' || formType === 'xfa-foreground' ? true
        : formType === 'none' || formType === 'acroform' ? false : 'unknown';
    const validPermissions = Number.isSafeInteger(info.permissions) && info.permissions !== null && info.permissions >= 0 && info.permissions <= 0xffffffff;
    const copy = info.encrypted ? validPermissions ? ((info.permissions as number) & COPY_FLAG) !== 0 : 'unknown' : true;
    const print = info.encrypted ? validPermissions ? ((info.permissions as number) & PRINT_FLAG) !== 0 : 'unknown' : true;
    const printHighQuality = info.encrypted ? validPermissions ? print === true && ((info.permissions as number) & PRINT_HIGH_QUALITY_FLAG) !== 0 : 'unknown' : true;
    const signed = Number.isSafeInteger(info.signatureCount) && (info.signatureCount as number) >= 0
        ? (info.signatureCount as number) > 0 : 'unknown';
    const repairStatus = info.repairStatus ?? 'unknown';
    const write = info.encrypted || xfa === true || signed === true || repairStatus === 'repaired' ? false
        : xfa === false && signed === false && repairStatus === 'clean' ? true : 'unknown';
    return { encrypted: info.encrypted, copy, print, printHighQuality, forms: info.hasForms, xfa,
        javascript: info.javascript === 'present' ? true : info.javascript === 'absent' ? false : 'unknown',
        formType, actions: info.actions ?? 'unknown', repairStatus, signed, render: true,
        capture: copy === false || xfa === true ? false : copy === true && xfa === false ? true : 'unknown', write };
}
