import type { RenderToken } from '../../platform/render/types';

const HASH = /^[0-9a-f]{64}$/;
const WRITE_ID = /^[0-9a-f]{32}$/;

export interface PaintSourceWitness {
    readonly token: RenderToken;
    readonly pristineFingerprint: string;
    readonly writeId: string | null;
}

export interface PaintSourceExpectation {
    readonly documentId: string;
    readonly session: number;
    readonly pristineFingerprint: string;
}

export interface PaintSourceAdmission {
    readonly token: RenderToken;
    readonly unchanged: boolean;
}

function sameOwner(token: RenderToken, expected: PaintSourceExpectation, current: RenderToken): boolean {
    return token.documentId === expected.documentId && token.session === expected.session && token.vaultEpoch === current.vaultEpoch;
}

export function admitPaintSourceRebind(current: RenderToken, expected: PaintSourceExpectation,
    witness: PaintSourceWitness, isCurrent: () => boolean): PaintSourceAdmission {
    if (!isCurrent()) throw new DOMException('Paint source rebind is no longer current', 'AbortError');
    const token = witness.token;
    if (!Number.isSafeInteger(token.bytesGeneration) || token.bytesGeneration < 0
        || !Number.isSafeInteger(token.vaultEpoch) || token.vaultEpoch < 0) throw new RangeError('Invalid paint source token');
    if (!sameOwner(token, expected, current)) throw new RangeError('Paint source rebind crosses its document, session or vault');
    if (token.bytesGeneration < current.bytesGeneration) throw new RangeError('Paint source rebind regresses the byte generation');
    if (!HASH.test(witness.pristineFingerprint) || witness.pristineFingerprint !== expected.pristineFingerprint) {
        throw new RangeError('Paint source rebind pristine identity does not match the admitted source');
    }
    if (witness.writeId !== null && !WRITE_ID.test(witness.writeId)) throw new RangeError('Paint source rebind has an invalid write identity');
    const frozen: RenderToken = Object.freeze({ vaultEpoch: token.vaultEpoch, documentId: token.documentId,
        bytesGeneration: token.bytesGeneration, session: token.session });
    return { token: frozen, unchanged: token.bytesGeneration === current.bytesGeneration };
}
