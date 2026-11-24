import type { RenderToken } from '../../platform/render/types';

const HASH = /^[0-9a-f]{64}$/;
const WRITE_ID = /^[0-9a-f]{32}$/;

/** The actual admitted source a rebind proves: its own token, its pristine identity and, once written, the write it came from. */
export interface PaintSourceWitness {
    readonly token: RenderToken;
    readonly pristineFingerprint: string;
    readonly writeId: string | null;
}

/** What the runtime already holds and must not change: the owner, the vault and the pristine identity it was admitted with. */
export interface PaintSourceExpectation {
    readonly documentId: string;
    readonly session: number;
    readonly pristineFingerprint: string;
}

export interface PaintSourceAdmission {
    /** A frozen copy of the witness token, the only token future pins may adopt. */
    readonly token: RenderToken;
    /** True when the witness is the token already in force, so nothing is adopted. */
    readonly unchanged: boolean;
}

function sameOwner(token: RenderToken, expected: PaintSourceExpectation, current: RenderToken): boolean {
    return token.documentId === expected.documentId && token.session === expected.session && token.vaultEpoch === current.vaultEpoch;
}

/**
 * Admits a rebind proof against the token currently in force. Only the same
 * owner, document and vault may rebind; the byte generation may stay or advance,
 * never regress; and the pristine identity must match the one admitted at
 * creation, so a different PDF cannot be adopted under this session.
 */
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
