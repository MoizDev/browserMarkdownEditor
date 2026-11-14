import { pageStack } from '../../platform/render';
import type { RenderToken } from '../../platform/render';
import type { PdfReadingBinding } from '../../types/reading';
import { getSessionIdentity } from '../../utils/sessionIdentity';
import { fingerprintSnapshot } from '../../utils/snapshotFingerprint';
import { PdfSelectionState } from '../text/selectionState';
import { getPdfSessionMirrors } from '../layer/tileMirror';
import { PdfTiledDocumentSession } from './documentSession';
import type { TiledDocumentPool } from './documentSession';
import type { PdfTiledSource, PdfTiledSourceFactory } from './hostTypes';
import { pdfSessionCapturer } from './sessionCapture';

const sourceSlot = Symbol('tiled PDF source');
interface Entry {
    readonly token: RenderToken;
    readonly session: PdfTiledDocumentSession;
    binding: PdfReadingBinding;
    ready?: Promise<PdfTiledSource>;
}

function matches(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
        a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}

/** A view can stop waiting without cancelling the App-owned shared open. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('PDF view closed', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('PDF view closed', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
            error => { signal.removeEventListener('abort', abort); reject(error); });
    });
}

/** This factory is lazy, while slot authority and identity remain App-owned. */
export function createPdfTiledSourceFactory(pool: TiledDocumentPool): PdfTiledSourceFactory {
    return {
        async open(reading, signal) {
            const id = reading.identity.documentId;
            const identity = getSessionIdentity(id);
            if (!identity) throw new DOMException('PDF App session is unavailable', 'AbortError');
            const token: RenderToken = { vaultEpoch: reading.identity.vaultEpoch, documentId: id,
                bytesGeneration: identity.bytesGeneration, session: identity.serial };
            const current = (candidate: RenderToken) => {
                const live = getSessionIdentity(candidate.documentId);
                return !!live && live.serial === candidate.session && live.bytesGeneration === candidate.bytesGeneration;
            };
            let entry = identity.getSlot<Entry>(sourceSlot);
            if (!entry || !matches(entry.token, token)) {
                const holder: { binding: PdfReadingBinding } = { binding: reading };
                const session = new PdfTiledDocumentSession(token, 'outer', requestSignal =>
                    holder.binding.acquireSnapshot(holder.binding.identity, requestSignal), pool, current,
                (blob, stat, requestSignal) => {
                    void fingerprintSnapshot(blob, requestSignal).then(hash => {
                        if (current(token)) holder.binding.onReaderVersion(holder.binding.identity, { ...stat, hash });
                    }).catch(() => {});
                });
                entry = { token, session, get binding() { return holder.binding; }, set binding(value) { holder.binding = value; } };
                identity.setSlot(sourceSlot, entry, old => old.session.close());
            } else entry.binding = reading;
            if (!entry.ready) {
                const owner = entry;
                const ready = (async () => {
                    const document = await owner.session.open();
                    if (!current(token)) throw new DOMException('PDF session replaced', 'AbortError');
                    const stack = pageStack(document.pages);
                    const mirror = getPdfSessionMirrors({ session: owner.session, token,
                        currentToken: () => current(token) ? token : null });
                    const capturer = pdfSessionCapturer(owner.session, stack);
                    const selection = new PdfSelectionState(document.poolDocument.docKey);
                    return { session: owner.session, document, mirror, capturer, selection };
                })();
                owner.ready = ready;
                void ready.catch(() => { if (owner.ready === ready) owner.ready = undefined; });
            }
            const ready = entry.ready;
            if (!ready) throw new Error('PDF session did not start');
            return waitFor(ready, signal);
        },
    };
}
