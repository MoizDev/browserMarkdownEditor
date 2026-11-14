import { PdfEngineError } from '../engine/types';
import { parsePdfDocKey } from '../worker/protocol';
import { Sha256 } from '../../utils/sha256';
import type { WriterSource } from './protocol';

const HASH = /^[0-9a-f]{64}$/;

async function hashBlob(blob: Blob, cooperate: () => Promise<void>): Promise<string> {
    const reader = blob.stream().getReader(), hash = new Sha256();
    try {
        for (;;) {
            await cooperate();
            const part = await reader.read();
            if (part.done) break;
            hash.update(part.value);
        }
        return hash.digest();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Pin the source identity and hash the actual immutable snapshots, not an App
 * pathname or a fingerprint supplied by an untrusted message. */
export async function validateWriterSource(source: WriterSource, cooperate: () => Promise<void>): Promise<void> {
    if (!source || !(source.pristine instanceof Blob) || !(source.outer instanceof Blob) ||
        source.pristine.size < 1 || source.outer.size < 1 || source.pristine.size >= 0x80000000 || source.outer.size >= 0x80000000) {
        throw new PdfEngineError('ResourceLimit', 'PDF source exceeds the supported byte range');
    }
    if (!HASH.test(source.pristineFingerprint) || !HASH.test(source.outerFingerprint)) throw new PdfEngineError('InvalidPdf', 'Invalid source fingerprint');
    let key;
    try { key = parsePdfDocKey(source.docKey); } catch { throw new PdfEngineError('InvalidPdf', 'Invalid writer document key'); }
    if (!source.token || source.token.vaultEpoch !== key.vaultEpoch || source.token.documentId !== key.documentId ||
        source.token.bytesGeneration !== key.bytesGeneration || !Number.isSafeInteger(source.token.session) || source.token.session < 0 ||
        key.source !== 'original') throw new PdfEngineError('InvalidPdf', 'Writer source identity does not match');
    const engine = source.geometryEngine;
    if (!engine || !engine.id || !engine.build || !Number.isSafeInteger(engine.generation) || engine.generation < 0) throw new PdfEngineError('InvalidPdf', 'Invalid geometry engine identity');
    if (await hashBlob(source.pristine, cooperate) !== source.pristineFingerprint ||
        await hashBlob(source.outer, cooperate) !== source.outerFingerprint) throw new PdfEngineError('InvalidPdf', 'PDF source fingerprint changed');
}
