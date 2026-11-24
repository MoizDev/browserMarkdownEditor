/**
 * Why Annotate is read-only for a PDF, in the person's words: what was found, what it means for the file, and what they
 * can do. The inspection's codes reached the screen as they were ("PDF ink is read-only: invalid-write-mark."), as did
 * its phases and error classes. The codes stay in the acquisition's `cause` for the code that branches on them.
 *
 * Damaged and undecided are told apart, as the page turn's refusals are (app/pdfGestures.ts `rotationRefusal`): an
 * inspection that could not decide (too large, ambiguous, nested, failed) must not tell anyone their annotations are damaged.
 */
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
            // What the mark is for: it proves the file is still as this app saved it. Writing now would rebuild the pages from
            // the embedded original and discard the other change (PdfPane's foreign-mark notice says the same).
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

/** The same for converting Classic annotations: the original is never changed by a refusal. */
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

/** A refusal, thrown under a name its catchers know, so it is shown as written rather than as an unexpected failure. */
export const PDF_INK_REFUSAL = 'PdfInkReadOnly';
export function inkRefusal(message: string): Error { return Object.assign(new Error(message), { name: PDF_INK_REFUSAL }); }
export function isInkRefusal(cause: unknown): cause is Error {
    return cause instanceof Error && (cause.name === PDF_INK_REFUSAL || cause.name === 'NotebookCopyOnlyRefusal');
}
