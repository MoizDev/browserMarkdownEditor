import { pageStack } from '../../platform/render';
import type { RenderToken } from '../../platform/render';
import type { PdfReadingBinding } from '../../types/reading';
import { awaitSessionDisposals, getSessionIdentity } from '../../utils/sessionIdentity';
import { fingerprintSnapshot } from '../../utils/snapshotFingerprint';
import type { DiskVersion } from '../../utils/diskVersion';
import { PdfSelectionState } from '../text/selectionState';
import { getPdfSessionMirrors } from '../layer/tileMirror';
import { PdfTiledDocumentSession } from './documentSession';
import type { TiledDocumentPool } from './documentSession';
import type { PdfTiledSource, PdfTiledSourceFactory } from './hostTypes';
import { pdfSessionCapturer } from './sessionCapture';
import { requestPdfPassword } from './passwords';
import { pdfMirrorRevision, pdfVersionTransitionOwner } from './versionOwner';

const sourceSlot = Symbol('tiled PDF source');
interface Entry {
    readonly token: RenderToken;
    readonly session: PdfTiledDocumentSession;
    binding: PdfReadingBinding;
    version?: Promise<DiskVersion>;
    stable?: Promise<Blob>;
    ready?: Promise<PdfTiledSource>;
}

function matches(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
        a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('PDF view closed', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('PDF view closed', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
            error => { signal.removeEventListener('abort', abort); reject(error); });
    });
}

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
            signal.throwIfAborted();
            await awaitSessionDisposals(id);
            signal.throwIfAborted();
            if (!current(token)) throw new DOMException('PDF session replaced during source release', 'AbortError');
            let entry = identity.getSlot<Entry>(sourceSlot);
            if (!entry || !matches(entry.token, token)) {
                const holder: { binding: PdfReadingBinding; version?: Promise<DiskVersion>; stable?: Promise<Blob> } = { binding: reading };
                const session = new PdfTiledDocumentSession(token, 'outer', requestSignal =>
                    holder.binding.acquireSnapshot(holder.binding.identity, requestSignal), pool, current,
                (stable, stat, requestSignal) => {
                    const version = stable.then(blob => fingerprintSnapshot(blob, requestSignal)).then(hash => ({ ...stat, hash }));
                    holder.version = version;
                    holder.stable = stable;
                    // Unversioned, the App never compares this document with the disk: a write that landed during the open
                    // left the old pages up for good with no DiskBar (measured: a 287 MB textbook overwritten 0.5 s after the click).
                    void stable.catch(error => {
                        if (requestSignal.aborted || (error instanceof DOMException && error.name === 'AbortError') || !session.isCurrent()) return;
                        holder.binding.onReaderSourceLost?.(holder.binding.identity, stat);
                    });
                    void version.catch(() => {});
                }, requestPdfPassword);
                entry = { token, session, get binding() { return holder.binding; }, set binding(value) { holder.binding = value; },
                    get version() { return holder.version; }, get stable() { return holder.stable; } };
                identity.setSlot(sourceSlot, entry, old => old.session.close());
            } else entry.binding = reading;
            await awaitSessionDisposals(id);
            signal.throwIfAborted();
            if (!current(token) || identity.getSlot(sourceSlot) !== entry) throw new DOMException('PDF session replaced during source release', 'AbortError');
            if (!entry.ready) {
                const owner = entry;
                const ready = (async () => {
                    const document = await owner.session.open();
                    if (!current(token)) throw new DOMException('PDF session replaced', 'AbortError');
                    const attempt = owner.version;
                    if (!attempt) throw new Error('PDF snapshot version unavailable');
                    const version = attempt.then(value => {
                        if (!current(token) || identity.getSlot(sourceSlot) !== owner || owner.version !== attempt || !owner.session.isCurrent()) {
                            throw new DOMException('PDF snapshot replaced', 'AbortError');
                        }
                        owner.binding.onReaderVersion(owner.binding.identity, value);
                        return value;
                    });
                    void version.catch(() => {});
                    const stack = pageStack(document.pages);
                    const mirror = getPdfSessionMirrors({ session: owner.session, token,
                        currentToken: () => current(token) ? token : null });
                    const capturer = pdfSessionCapturer(owner.session, stack);
                    const selection = new PdfSelectionState(document.poolDocument.docKey);
                    const transition = pdfVersionTransitionOwner(id, 'outer');
                    const bridge = await transition.adopt({ session: owner.session, document, mirror },
                        () => pdfMirrorRevision(owner.binding.emphasisEnabled, document.poolDocument.docKey, document.emphasis.revision()),
                        owner.session.lifetimeSignal);
                    owner.session.lifetimeSignal.throwIfAborted();
                    if (!current(token)) throw new DOMException('PDF session replaced', 'AbortError');
                    return { session: owner.session, document, mirror, capturer, selection, transition, bridge, version };
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

export async function pdfReaderBytes(documentId: string): Promise<{ blob: Blob; version: DiskVersion } | undefined> {
    const identity = getSessionIdentity(documentId);
    const entry = identity?.getSlot<Entry>(sourceSlot);
    if (!identity || !entry?.stable || !entry.version || entry.token.session !== identity.serial
        || entry.token.bytesGeneration !== identity.bytesGeneration || !entry.session.isCurrent()) return undefined;
    try {
        const [blob, version] = await Promise.all([entry.stable, entry.version]);
        return entry.session.isCurrent() ? { blob, version } : undefined;
    } catch { return undefined; }
}
