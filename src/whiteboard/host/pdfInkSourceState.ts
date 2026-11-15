import { getSessionIdentity } from '../../utils/sessionIdentity';
import type { PdfInkSourceState } from './preparePdfInkSession';

export const pdfInkSourceSlot = Symbol('native PDF ink source state');

/** Views borrow the actual App-owned source without importing acquisition/writer code. */
export function getPdfInkSourceState(documentId: string): PdfInkSourceState | undefined {
    return getSessionIdentity(documentId)?.getSlot<PdfInkSourceState>(pdfInkSourceSlot);
}
