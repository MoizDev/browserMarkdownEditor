// Deliberate capacity refusals cross the worker boundary as data, not a failed
// IO exception. App keeps the revision dirty and reports the reason as skipped.
import { PDF_EDITABLE_JSON_LIMIT } from './pdfRole';

export interface PdfBuildRefusal {
    reason: 'editable-json-limit';
    limit: number;
}

export class PdfBuildRefused extends Error {
    readonly refusal: PdfBuildRefusal;
    constructor(refusal: PdfBuildRefusal) {
        super('The editable annotations exceed the 32 MiB limit. The PDF has not been changed; keep your unsaved annotations open or reduce their size before saving.');
        this.name = 'PdfBuildRefused';
        this.refusal = refusal;
    }
}

/** Count UTF-8 without allocating an oversized encoded attachment. Lone UTF-16
 *  surrogates become the same three-byte replacement as TextEncoder uses. */
export function pdfSnapshotRefusal(snapshot: string): PdfBuildRefusal | undefined {
    const refused: PdfBuildRefusal = { reason: 'editable-json-limit', limit: PDF_EDITABLE_JSON_LIMIT };
    if (snapshot.length > PDF_EDITABLE_JSON_LIMIT) return refused;
    let bytes = 0;
    for (let i = 0; i < snapshot.length; i++) {
        const unit = snapshot.charCodeAt(i);
        if (unit <= 0x7f) bytes++;
        else if (unit <= 0x7ff) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < snapshot.length &&
            snapshot.charCodeAt(i + 1) >= 0xdc00 && snapshot.charCodeAt(i + 1) <= 0xdfff) {
            bytes += 4; i++;
        } else bytes += 3;
        if (bytes > PDF_EDITABLE_JSON_LIMIT) return refused;
    }
}
