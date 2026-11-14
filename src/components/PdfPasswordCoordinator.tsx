import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ReaderIdentity } from '../types/reading';
import { getSessionIdentity, subscribeSessionIdentity } from '../utils/sessionIdentity';
import PdfPasswordPrompt from './PdfPasswordPrompt';

interface Token { vaultEpoch: number; documentId: string; bytesGeneration: number; session: number }
interface PasswordStore {
    subscribePdfPassword(listener: () => void): () => void;
    getPdfPasswordSnapshot(): { id: number; token: Token; incorrect: boolean; owner: symbol | null } | null;
    registerPdfPasswordPresenter(owner: symbol, token: Token): () => void;
    answerPdfPassword(owner: symbol, id: number, answer: string | null): void;
}

/** The lazy tiled boundary supplies the store; each surface offers its identity. */
export default function PdfPasswordCoordinator({ identity, store }: { identity: Pick<ReaderIdentity, 'vaultEpoch' | 'documentId'>; store: PasswordStore }) {
    const [owner] = useState(() => Symbol('PDF password presenter'));
    const getIdentity = useCallback(() => getSessionIdentity(identity.documentId), [identity.documentId]);
    const session = useSyncExternalStore(subscribeSessionIdentity, getIdentity, () => undefined);
    const attempt = useSyncExternalStore(store.subscribePdfPassword, store.getPdfPasswordSnapshot, () => null);
    useEffect(() => {
        if (!session) return;
        return store.registerPdfPasswordPresenter(owner, { vaultEpoch: identity.vaultEpoch, documentId: identity.documentId,
            bytesGeneration: session.bytesGeneration, session: session.serial });
    }, [owner, identity.vaultEpoch, identity.documentId, session, store]);
    if (!attempt || attempt.owner !== owner || !session || attempt.token.vaultEpoch !== identity.vaultEpoch ||
        attempt.token.documentId !== identity.documentId || attempt.token.session !== session.serial ||
        attempt.token.bytesGeneration !== session.bytesGeneration) return null;
    return createPortal(<PdfPasswordPrompt key={attempt.id} attemptId={attempt.id} incorrect={attempt.incorrect}
        onSubmit={password => store.answerPdfPassword(owner, attempt.id, password)}
        onCancel={() => store.answerPdfPassword(owner, attempt.id, null)} />, document.body);
}
