import { pdfWriteMarkV2Placeholder } from '../../utils/pdfWriteMark';
import { attachmentMarker } from './attachments';

export const WRITE_MARK_ATTACHMENT = '.vault-write-mark';

/** Generated once before freezing board.json; the board records this opaque id. */
export function newPdfWriteId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Add this attachment last, then set both Params keys before full save. PDFium
 * Flate-encodes the payload but serializes the Params literal before that data. */
export function pdfiumWriteMark(format: string, writeId: string): {
    name: string; payload: Uint8Array; marker: string; value: string;
} {
    return {
        name: WRITE_MARK_ATTACHMENT,
        payload: new Uint8Array([0]),
        marker: attachmentMarker('write-mark', format),
        value: pdfWriteMarkV2Placeholder(writeId),
    };
}
