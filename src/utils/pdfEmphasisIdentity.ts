import { hashBytes } from './diskVersion';

/** The generation token permits immediate paint/probing while the immutable
 * raw-byte fingerprint is computed asynchronously. */
export interface PdfEmphasisIdentity { token: string; hash: Promise<string> }
export function createPdfEmphasisIdentity(bytes: Uint8Array): PdfEmphasisIdentity {
    const hash = hashBytes(bytes);
    void hash.catch(() => {});
    return { token: crypto.randomUUID(), hash };
}
