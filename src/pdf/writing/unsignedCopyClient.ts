import { Sha256 } from '../../utils/sha256';
import type { PdfPool } from '../pool/types';
import { hashNotebookOutput } from './verifyNotebookOutput';

/** This result authorizes no write; the caller must warn and choose a distinct target. */
export interface UnsignedPdfCopy {
    readonly kind: 'unsigned-copy-only';
    readonly bytes: ArrayBuffer;
    readonly originalSha: string;
    readonly attachmentName: string;
}

export async function prepareUnsignedPdfCopy(options: { pool: PdfPool; source: Blob; originalSha: string; isCurrent(): boolean; signal: AbortSignal }): Promise<UnsignedPdfCopy> {
    const { pool, source, signal } = options;
    const guard = () => {
        signal.throwIfAborted();
        if (!options.isCurrent()) throw new DOMException('Signed PDF source changed', 'AbortError');
    };
    if (!(source instanceof Blob) || typeof File !== 'undefined' && source instanceof File || !source.size || source.size >= 0x80000000 ||
        !/^[0-9a-f]{64}$/.test(options.originalSha)) throw new Error('Invalid signed PDF snapshot');
    const digest = new Sha256();
    for (let at = 0; at < source.size; at += 1024 * 1024) {
        guard(); const bytes = await source.slice(at, at + 1024 * 1024).arrayBuffer(); guard(); digest.update(new Uint8Array(bytes));
    }
    if (digest.digest() !== options.originalSha) throw new Error('Signed PDF snapshot fingerprint changed');
    guard();
    const producer = await pool.writer({ signal });
    let prepared: Awaited<ReturnType<typeof produce>>;
    const produce = () => producer.request('writer.prepareUnsignedCopy', { source }, { priority: 0, signal });
    try { guard(); prepared = await produce(); guard(); }
    finally { await producer.close(); }
    guard();
    if (prepared.originalSha !== options.originalSha) throw new Error('Signed PDF source fingerprint did not match');
    const length = prepared.bytes.byteLength, outputSha = await hashNotebookOutput(prepared.bytes, signal);
    guard();
    const verifier = await pool.writer({ signal });
    let verified: UnsignedPdfCopy;
    try {
        guard();
        const proof = await verifier.request('writer.verifyUnsignedCopy', { source, bytes: prepared.bytes, attachmentName: prepared.attachmentName }, { priority: 0, signal });
        guard();
        if (proof.bytes.byteLength !== length || proof.originalSha !== options.originalSha || proof.outputSha !== outputSha ||
            await hashNotebookOutput(proof.bytes, signal) !== outputSha) throw new Error('Unsigned PDF copy verification failed');
        guard();
        verified = { kind: 'unsigned-copy-only', bytes: proof.bytes, originalSha: proof.originalSha, attachmentName: prepared.attachmentName };
    } finally { await verifier.close(); }
    guard();
    return verified;
}
