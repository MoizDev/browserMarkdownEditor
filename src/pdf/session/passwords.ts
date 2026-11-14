import type { RenderToken } from '../../platform/render/types';
import { getSessionIdentity, subscribeSessionIdentity } from '../../utils/sessionIdentity';

interface Attempt {
    readonly id: number;
    readonly token: RenderToken;
    readonly incorrect: boolean;
    readonly signal: AbortSignal;
    readonly resolve: (answer: string | null) => void;
    readonly reject: (error: Error) => void;
    readonly abort: () => void;
}
export interface PdfPasswordSnapshot {
    readonly id: number;
    readonly token: RenderToken;
    readonly incorrect: boolean;
    readonly owner: symbol | null;
}

const attempts: Attempt[] = [];
const presenters = new Map<symbol, RenderToken>();
const listeners = new Set<() => void>();
let snapshot: PdfPasswordSnapshot | null = null;
let nextId = 0, unsubscribeIdentity: (() => void) | undefined;
const aborted = () => new DOMException('PDF password request cancelled', 'AbortError');
const sameToken = (a: RenderToken, b: RenderToken) => a.vaultEpoch === b.vaultEpoch &&
    a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
const current = (token: RenderToken) => {
    const identity = getSessionIdentity(token.documentId);
    return !!identity && identity.serial === token.session && identity.bytesGeneration === token.bytesGeneration;
};

function publish(): void {
    const attempt = attempts[0];
    const owner = attempt ? [...presenters].find(([, token]) => sameToken(token, attempt.token))?.[0] ?? null : null;
    if ((!attempt && !snapshot) || (attempt && snapshot?.id === attempt.id && snapshot.owner === owner)) return;
    snapshot = attempt ? Object.freeze({ id: attempt.id, token: attempt.token, incorrect: attempt.incorrect, owner }) : null;
    for (const listener of [...listeners]) { try { listener(); } catch { /* An observer cannot strand an attempt. */ } }
}
function finish(attempt: Attempt, answer: string | null, cancelled: boolean): void {
    const index = attempts.indexOf(attempt);
    if (index < 0) return;
    attempts.splice(index, 1);
    attempt.signal.removeEventListener('abort', attempt.abort);
    if (!attempts.length) { unsubscribeIdentity?.(); unsubscribeIdentity = undefined; }
    publish();
    if (cancelled) attempt.reject(aborted()); else attempt.resolve(answer);
}
function invalidate(): void {
    for (const attempt of [...attempts]) if (attempt.signal.aborted || !current(attempt.token)) finish(attempt, null, true);
}

/** The session owns the signal. No password is kept in the store or persisted. */
export function requestPdfPassword(token: RenderToken, incorrect: boolean, signal: AbortSignal): Promise<string | null> {
    if (!token || typeof token.documentId !== 'string' || !token.documentId ||
        !Number.isSafeInteger(token.vaultEpoch) || token.vaultEpoch < 0 ||
        !Number.isSafeInteger(token.bytesGeneration) || token.bytesGeneration < 0 ||
        !Number.isSafeInteger(token.session) || token.session < 1 || typeof incorrect !== 'boolean' ||
        signal.aborted || !current(token)) return Promise.reject(aborted());
    if (nextId === Number.MAX_SAFE_INTEGER) return Promise.reject(new RangeError('PDF password attempt identity exhausted'));
    const frozen = Object.freeze({ vaultEpoch: token.vaultEpoch, documentId: token.documentId,
        bytesGeneration: token.bytesGeneration, session: token.session });
    return new Promise((resolve, reject) => {
        const attempt: Attempt = { id: ++nextId, token: frozen, incorrect, signal, resolve, reject,
            abort: () => finish(attempt, null, true) };
        attempts.push(attempt);
        if (!unsubscribeIdentity) unsubscribeIdentity = subscribeSessionIdentity(invalidate);
        signal.addEventListener('abort', attempt.abort, { once: true });
        if (signal.aborted || !current(frozen)) finish(attempt, null, true);
        else publish();
    });
}

export function subscribePdfPassword(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getPdfPasswordSnapshot(): PdfPasswordSnapshot | null { return snapshot; }

/** Each surface registers its exact current identity. Only one presents the head. */
export function registerPdfPasswordPresenter(owner: symbol, token: RenderToken): () => void {
    presenters.set(owner, Object.freeze({ ...token })); publish();
    return () => { presenters.delete(owner); publish(); };
}
export function answerPdfPassword(owner: symbol, id: number, answer: string | null): void {
    const attempt = attempts[0], presenter = presenters.get(owner);
    if (!attempt || attempt.id !== id || snapshot?.owner !== owner || !presenter || !sameToken(presenter, attempt.token)) return;
    if (attempt.signal.aborted || !current(attempt.token)) { finish(attempt, null, true); return; }
    finish(attempt, answer, false);
}
