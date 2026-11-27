import { pdfWriteMarkV2Placeholder } from '../../utils/pdfWriteMark';
import { attachmentMarker } from './attachments';

export const WRITE_MARK_ATTACHMENT = '.vault-write-mark';

export function newPdfWriteId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

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
