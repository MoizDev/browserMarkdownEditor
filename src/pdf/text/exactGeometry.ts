import type { PageGeometry } from '../../platform/types';
import type { PdfPoolDocument, PdfRequestOptions } from '../pool/types';

export async function exactPdfTextGeometry(document: PdfPoolDocument, page: number,
    priority: 0 | 1 | 2 | 3, signal: AbortSignal): Promise<Readonly<PageGeometry>> {
    const pool = document as PdfPoolDocument & {
        resolveGeometry(index: number, options: PdfRequestOptions): Promise<Readonly<PageGeometry>>;
    };
    const key = document.docKey;
    const geometry = await pool.resolveGeometry(page, { priority, signal });
    if (signal.aborted || document.closed || document.docKey !== key) throw new DOMException('PDF geometry cancelled', 'AbortError');
    if (geometry.index !== page) throw new Error('The PDF worker returned stale page geometry.');
    return geometry;
}
