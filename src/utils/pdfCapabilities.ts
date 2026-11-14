import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Permission state is deliberately tri-state: an unavailable result is not
 * evidence that extraction or mutation is allowed. */
export interface PdfCapabilities {
    encrypted: boolean | 'unknown';
    copy: boolean | 'unknown';
    forms: boolean | 'unknown';
    xfa: boolean | 'unknown';
    javascript: boolean | 'unknown';
}

const COPY_FLAG = 1 << 4;
export const PDF_COPY_RESTRICTED = 'This PDF does not permit copying or text extraction.';
export const PDF_COPY_UNKNOWN = 'PDF copy permissions could not be established; text extraction is unavailable.';
export const PDF_ENCRYPTED_READ_ONLY = 'Encrypted PDFs are read-only; annotation and rotation are unavailable.';

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
    return { encrypted, copy, forms: flag('IsAcroFormPresent'), xfa: flag('IsXFAPresent'),
        javascript: 'unknown' };
}

/** Unknown native flags are displayed as unknown, never advertised as clean. */
export function tiledPdfCapabilities(info: { encrypted: boolean; permissions: number | null; hasForms: boolean }): PdfCapabilities {
    return { encrypted: info.encrypted,
        copy: info.encrypted ? info.permissions === null ? 'unknown' : (info.permissions & COPY_FLAG) !== 0 : true,
        forms: info.hasForms, xfa: 'unknown', javascript: 'unknown' };
}
