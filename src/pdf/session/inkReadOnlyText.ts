const READ = 'You can still read it in Original.';
const KEPT = 'so it is not opened for annotating and the file is left as it is.';

export type PdfInkRefusal =
    | 'invalid-source' | 'encrypted' | 'signed' | 'unreadable' | 'ambiguous' | 'unsupported-format' | 'unsupported'
    | 'missing-attachment' | 'invalid-marker' | 'invalid-write-mark' | 'nested-source' | 'resource-limit' | 'unsafe-policy'
    | 'inspection-failed' | 'source-changed' | 'mismatch' | 'permissions';

export function inkReadOnlyText(reason: PdfInkRefusal | string): string {
    switch (reason) {
        case 'encrypted': return `This PDF is encrypted, so it cannot be annotated here. ${READ}`;
        case 'signed': return `This PDF is signed, and annotating it would break the signature. ${READ} To annotate it, create an unsigned copy and annotate that.`;
        case 'invalid-write-mark':
            return `This PDF was changed by another program after its annotations were saved here, or saved by a newer version of this app. Annotating it now would discard that change, ${KEPT} ${READ}`;
        case 'missing-attachment': case 'invalid-marker':
            return `The annotations saved inside this PDF are incomplete or damaged, ${KEPT} ${READ}`;
        case 'ambiguous': case 'nested-source': case 'inspection-failed':
            return `The annotations saved inside this PDF could not be checked with certainty, ${KEPT} ${READ}`;
        case 'resource-limit': return `This PDF is too large or complex for its annotations to be checked here, ${KEPT} ${READ}`;
        case 'mismatch': return `The annotations saved inside this PDF do not match its pages, ${KEPT} ${READ}`;
        case 'source-changed': return 'This PDF changed while it was being opened for annotating. Switch to Original and back to Annotate to open it as it is now.';
        case 'unsafe-policy': case 'unsupported-format': case 'unsupported': case 'permissions':
            return `This PDF has parts this app cannot rewrite with certainty (forms, permissions or an unusual structure), so it cannot be annotated here. ${READ}`;
        default: return `This PDF could not be read well enough to annotate it safely. ${READ}`;
    }
}

export function legacyConversionRefusalText(reason: PdfInkRefusal | string): string {
    const kept = 'The original PDF and its Classic annotations are unchanged.';
    switch (reason) {
        case 'encrypted': return `This PDF is encrypted, so its Classic annotations cannot be converted. ${kept}`;
        case 'signed': return `This PDF is signed, and converting its annotations would break the signature. ${kept} To convert them, create an unsigned copy and convert that.`;
        case 'source-changed': return `This PDF changed while its annotations were being read. ${kept} Switch to Original and back to Annotate to try again.`;
        case 'mismatch': return `The Classic annotations in this PDF do not match its pages, so they cannot be converted. ${kept}`;
        case 'unsupported': case 'unsafe-policy': case 'permissions':
            return `This PDF has parts this app cannot rewrite with certainty (forms, permissions or an unusual structure), so its annotations cannot be converted. ${kept}`;
        default: return `The Classic annotations in this PDF could not be read with certainty, so they cannot be converted. ${kept}`;
    }
}

export const PDF_INK_REFUSAL = 'PdfInkReadOnly';
export function inkRefusal(message: string): Error { return Object.assign(new Error(message), { name: PDF_INK_REFUSAL }); }
export function isInkRefusal(cause: unknown): cause is Error {
    return cause instanceof Error && (cause.name === PDF_INK_REFUSAL || cause.name === 'NotebookCopyOnlyRefusal');
}
