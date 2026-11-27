import type { prepareOwnedPdfInk } from '../../pdf/session/ownedInkAcquisition';
import type { PdfRuntimeInkSource } from '../../pdf/session/legacyInkAcquisition.types';
import type { createPdfInkHost, pinPdfInkHostForSave, readPdfInkLegacyDigest, rebindPdfInkSource, validateLoadedPdfInkHost } from '../../pdf/session/inkHost';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { SourceOwner } from '../../utils/documentBuffers';
import { getSessionIdentity } from '../../utils/sessionIdentity';
import { mediaExtension } from '../media/ingest';
import { hashMedia } from '../media/sha256';
import { MEDIA_MIMES, type MediaId } from '../model/media';
import { createPdfInkRebind, type PdfInkRebindSnapshot } from './pdfInkRebind';
import { prepareNativePdfRuntime } from './prepareNativePdfRuntime';
import type { PdfInkSourceLease } from './pdfInkSourceOwner';
import { pdfInkSourceSlot as sourceSlot } from './pdfInkSourceState';
export { getPdfInkSourceState } from './pdfInkSourceState';

export interface PdfInkSourceState {
    retainSource(): PdfInkSourceLease;
    getSnapshot(): PdfInkRebindSnapshot;
    subscribe(listener: () => void): () => void;
    readMedia(id: MediaId, signal: AbortSignal): Promise<Blob>;
    adoptWritten(): Promise<void>;
}

export interface PreparePdfInkSessionOptions {
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
    readonly zMax: number;
    readonly requireExistingNative?: boolean;
    readonly prepareOwned: typeof prepareOwnedPdfInk;
    readonly createHost: typeof createPdfInkHost;
    readonly validateLoadedHost: typeof validateLoadedPdfInkHost;
    readonly readLegacyDigest: typeof readPdfInkLegacyDigest;
    readonly pinHost: typeof pinPdfInkHostForSave;
    readonly rebind: typeof rebindPdfInkSource;
    currentReadOnly(): string | null;
    onReadOnly(reason: string): void;
    onError(error: unknown): void;
    onHistoryLimit(): void;
}

const stale = () => new DOMException('PDF ink session ended', 'AbortError');

export async function preparePdfInkSession(options: PreparePdfInkSessionOptions) {
    const { host, identity, signal } = options, documentId = identity.documentId;
    const current = () => identity.kind === 'pdfInk' && host.isCurrent(identity) &&
        getSessionIdentity(documentId)?.serial === identity.session;
    if (!current()) throw stale();
    const outer = await host.acquireBytes(identity, signal);
    signal.throwIfAborted();
    if (!current()) throw stale();
    const token = { documentId, session: identity.session, vaultEpoch: identity.vaultActivation, bytesGeneration: identity.bytesGeneration };
    const acquisition = await options.prepareOwned({ outer, token, isCurrent: current }, signal);
    if (acquisition.kind === 'read-only') {
        if (signal.aborted || !current()) { await acquisition.dispose(); throw stale(); }
        return { kind: 'read-only' as const, reason: acquisition.reason,
            ...(acquisition.notebookSource && acquisition.outerFingerprint && acquisition.isCurrent ? {
                notebookSource: acquisition.notebookSource, outerFingerprint: acquisition.outerFingerprint,
                isCurrent: () => !signal.aborted && current() && acquisition.isCurrent!(),
            } : {}),
            dispose: () => acquisition.dispose() };
    }
    let accepted;
    try { signal.throwIfAborted(); if (!current()) throw stale(); accepted = acquisition.take(); }
    catch (error) { await acquisition.dispose(); throw error; }
    if (options.requireExistingNative && accepted.kind !== 'native') {
        await accepted.release();
        throw new Error('Open Annotate before editing an unannotated PDF.');
    }
    return prepareAcceptedPdfInkSession(options, accepted);
}

export async function prepareAcceptedPdfInkSession(options: PreparePdfInkSessionOptions, accepted: PdfRuntimeInkSource,
    onTransfer?: () => void) {
    const { host, identity, signal } = options, documentId = identity.documentId;
    const current = () => identity.kind === 'pdfInk' && host.isCurrent(identity) &&
        getSessionIdentity(documentId)?.serial === identity.session;
    let controller: ReturnType<typeof createPdfInkRebind> | undefined;
    const prepared = await prepareNativePdfRuntime({ host, identity, accepted, signal, deadlineMs: options.deadlineMs, zMax: options.zMax,
        createHost: options.createHost, validateLoadedHost: options.validateLoadedHost, readLegacyDigest: options.readLegacyDigest, pinHost: options.pinHost,
        currentReadOnly: () => {
            const state = controller?.getSnapshot();
            return state && (state.status === 'read-only' || state.status === 'failed')
                ? state.reason ?? 'PDF ink editing is unavailable.' : options.currentReadOnly();
        },
        afterWritten: (revision, written, sources) => {
            if (!controller || sources !== prepared.sources) throw new Error('PDF rebind controller is not initialized');
            return controller.afterWritten(revision, written);
        }, onError: options.onError, onHistoryLimit: options.onHistoryLimit });
    try {
        signal.throwIfAborted();
        if (!current()) throw stale();
        controller = createPdfInkRebind({ host, documentId, admittedIdentity: identity, initialSource: accepted,
            sources: prepared.sources, rebind: options.rebind,
            adoptPaint(witness, isCurrent) {
                const runtime = prepared.runtime();
                const live = () => {
                    const outer = host.outerIdentity(documentId), token = witness.token;
                    return !!runtime && current() && isCurrent() && prepared.runtime() === runtime && !!outer
                        && outer.kind === 'pdfInk' && host.isCurrent(outer) && outer.documentId === token.documentId
                        && outer.session === token.session && outer.vaultActivation === token.vaultEpoch
                        && outer.bytesGeneration === token.bytesGeneration;
                };
                if (!runtime || !live()) throw stale();
                runtime.adoptPaintSource(witness, { documentId, session: identity.session,
                    pristineFingerprint: accepted.source.pristineFingerprint }, live);
            },
            onError: options.onError, onReadOnly: options.onReadOnly });
    } catch (error) { await prepared.dispose(); throw error; }
    const rebind = controller;
    let transferred = false, stagingDisposed = false;
    return {
        kind: 'ready' as const, legacyOriginalSha256: prepared.legacyOriginalSha256,
        conversionPending: accepted.kind === 'legacy-converted',
        take(owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean, readOnlyReason: () => string | null) {
            if (transferred || stagingDisposed || !current() || owner.documentId !== documentId || owner.session !== identity.session || !isLiveOwner(owner)) throw stale();
            const slot = getSessionIdentity(documentId);
            if (!slot || slot.serial !== owner.session || slot.getSlot(sourceSlot)) throw new Error('A PDF ink source is already owned by this session');
            const owned = prepared.take(owner, isLiveOwner, readOnlyReason);
            transferred = true;
            let closed = false, closing: Promise<void> | undefined;
            const facade: PdfInkSourceState = {
                retainSource() {
                    if (closed || !current() || !isLiveOwner(owner)) throw stale();
                    return prepared.sources.retain();
                },
                getSnapshot: rebind.getSnapshot, subscribe: rebind.subscribe,
                adoptWritten() { return closed || !current() || !isLiveOwner(owner) ? Promise.resolve() : rebind.adoptWritten(); },
                async readMedia(id, mediaSignal) {
                    mediaSignal.throwIfAborted();
                    if (closed || !current() || !isLiveOwner(owner)) throw stale();
                    const entry = owned.board.doc.media.get(id);
                    const mime = MEDIA_MIMES.find(value => value === entry?.mime);
                    if (!entry || entry.file !== null || !mime || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`Invalid embedded PDF media: ${id}`);
                    const source = rebind.getSnapshot().source;
                    const blob = await source.readMedia(`board-media/${id.slice(7)}.${mediaExtension(mime)}`, mediaSignal);
                    mediaSignal.throwIfAborted();
                    if (closed || !current() || !isLiveOwner(owner) || rebind.getSnapshot().source !== source) throw stale();
                    if (blob.size !== entry.bytes || await hashMedia(blob, mediaSignal) !== id) throw new Error(`Corrupt embedded PDF media: ${id}`);
                    mediaSignal.throwIfAborted();
                    if (closed || !current() || !isLiveOwner(owner) || rebind.getSnapshot().source !== source) throw stale();
                    return blob;
                },
            };
            const close = (): Promise<void> => {
                if (closing) return closing;
                closed = true;
                rebind.dispose();
                closing = Promise.resolve().then(async () => {
                    try { await owned.dispose(); } finally { await rebind.drain(); }
                });
                const live = getSessionIdentity(documentId);
                if (live?.serial === owner.session && live.getSlot(sourceSlot) === facade) live.setSlot(sourceSlot, undefined);
                return closing;
            };
            try { slot.setSlot(sourceSlot, facade, () => close()); }
            catch (error) { void close().catch(options.onError); throw error; }
            if (closed) throw stale();
            try { onTransfer?.(); } catch (error) { void close().catch(options.onError); throw error; }
            const canWriteSource = () => {
                try {
                    const state = rebind.getSnapshot(), outer = host.outerIdentity(documentId), token = state.source.source.token;
                    return !closed && current() && isLiveOwner(owner) && state.status === 'ready'
                        && !!outer && host.isCurrent(outer) && outer.documentId === token.documentId && outer.session === token.session
                        && outer.vaultActivation === token.vaultEpoch && outer.bytesGeneration === token.bytesGeneration
                        && state.source.writeSafety.kind === 'safe' && state.source.isCurrent();
                } catch { return false; }
            };
            const pdfWriteAuthority = Object.freeze({ canWriteSource, canWrite: () => canWriteSource() && !owned.board.isReadOnly });
            return { board: owned.board, pdfWriteAuthority, dispose: close };
        },
        async dispose() {
            if (transferred || stagingDisposed) return;
            stagingDisposed = true;
            rebind.dispose();
            try { await prepared.dispose(); } finally { await rebind.drain(); }
        },
    };
}
