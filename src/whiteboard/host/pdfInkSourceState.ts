import { getSessionIdentity } from '../../utils/sessionIdentity';
import type { PdfInkSourceState } from './preparePdfInkSession';

export const pdfInkSourceSlot = Symbol('native PDF ink source state');

export function getPdfInkSourceState(documentId: string): PdfInkSourceState | undefined {
    return getSessionIdentity(documentId)?.getSlot<PdfInkSourceState>(pdfInkSourceSlot);
}
