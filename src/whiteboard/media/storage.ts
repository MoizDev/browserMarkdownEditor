import { inspectedMediaBytes } from './inspect';
import { isSafeMediaFile, type MediaEntry } from '../model/media';
import type { MediaLease } from './store';
import type { MediaStorageDestination, MediaStorageReceipt, MediaStorageRequest, MediaStorageResult } from './storage.types';

interface ReceiptState {
    readonly request: MediaStorageRequest;
    readonly destination: MediaStorageDestination;
    readonly document: MediaStorageRequest['runtime']['session']['doc'];
    readonly revision: number;
    readonly hadBytes: boolean;
    readonly hold: MediaLease;
    committedRevision: number | null;
}
const issued = new WeakMap<MediaStorageReceipt, ReceiptState>();
const ended = () => new DOMException('Media storage receipt ended or became stale', 'AbortError');
const sameToken = (a: Readonly<{ documentId: string; session: number; vaultEpoch: number; bytesGeneration: number }>, b: typeof a) =>
    a.documentId === b.documentId && a.session === b.session && a.vaultEpoch === b.vaultEpoch && a.bytesGeneration === b.bytesGeneration;
function matchingEntry(a: MediaEntry, b: MediaEntry): boolean {
    return a.id === b.id && a.mime === b.mime && a.bytes === b.bytes && a.w === b.w && a.h === b.h
        && a.duration === b.duration && a.animated === b.animated;
}
function check(state: ReceiptState, checkRevision = true): void {
    const { runtime, context } = state.request, session = runtime.session;
    runtime.jobs.assertContext(context); context.assertCurrent(); context.signal.throwIfAborted();
    if (session.doc !== state.document || session.isReadOnly
        || checkRevision && session.doc.rev !== (state.committedRevision ?? state.revision)) throw ended();
    state.destination.assertWritable();
    if (state.destination.kind === 'embedded') {
        const { token, source } = state.destination;
        if (session.doc.kind !== 'pdf-ink' || token.documentId !== session.owner.documentId || token.session !== session.owner.session
            || token.vaultEpoch !== context.job.vaultEpoch || !source.source.isCurrent()
            || !sameToken(token, source.source.source.token)) throw ended();
    }
}

/** The App calls this only after its actual filesystem write or writable-source
 * retention. The issuer independently verifies the inspection, running job and
 * canonical byte store; a null filename is never an embedded-media authority. */
export function issueMediaStorageReceipt(request: MediaStorageRequest, destination: MediaStorageDestination): MediaStorageReceipt {
    const { runtime, context, entry, blob, inspection } = request, session = runtime.session, document = session.doc, revision = document.rev;
    runtime.jobs.assertContext(context); context.assertCurrent();
    const bytes = inspectedMediaBytes(inspection, blob, { session: context.job.session, epoch: context.job.vaultEpoch, revision });
    if (entry.id !== inspection.id || entry.mime !== inspection.mime || entry.bytes !== bytes.size
        || entry.w !== inspection.width || entry.h !== inspection.height || entry.duration !== inspection.duration
        || entry.animated !== inspection.animated) throw new TypeError('Stored media differs from its actual inspection');
    if (destination.kind === 'file' && (document.kind === 'pdf-ink' || typeof destination.file !== 'string' || !isSafeMediaFile(destination.file))) {
        throw new TypeError('PDF media must remain embedded; filesystem storage requires a real safe filename');
    }
    const hold = runtime.media.retain(entry.id, 'snapshot');
    const initial: ReceiptState = { request, destination, document, revision, hadBytes: !!runtime.media.get(entry.id), hold, committedRevision: null };
    let state: ReceiptState | null = initial;
    try {
        check(initial);
        runtime.media.put(entry.id, bytes);
        const owner = Object.freeze({ documentId: session.owner.documentId, session: session.owner.session });
        const active = (): ReceiptState => { if (!state) throw ended(); return state; };
        const base = {
            id: entry.id, owner,
            assertCurrent() { check(active()); },
            committed() {
                const current = active(); check(current, false);
                if (current.committedRevision !== null) return;
                const { runtime, entry } = current.request, session = runtime.session, destination = current.destination;
                const stored = session.doc.media.get(entry.id), cached = runtime.media.get(entry.id);
                if (!stored || !matchingEntry(entry, stored) || stored.file !== (destination.kind === 'file' ? destination.file : null)
                    || !(session.doc.mediaRefs.get(entry.id)?.size || session.doc.preservedMediaRefs.get(entry.id)) || !cached || cached.size !== entry.bytes
                    || session.doc.rev < current.revision || session.doc.rev === current.revision && !current.hadBytes) {
                    throw new Error('Stored media was not handed to the actual media/node transaction');
                }
                current.committedRevision = session.doc.rev;
                runtime.media.setFile(entry.id, stored.file);
            },
            release() {
                const previous = state; if (!previous) return;
                state = null; issued.delete(receipt);
                try { previous.hold.release(); }
                finally { if (previous.destination.kind === 'embedded') previous.destination.source.release(); }
            },
        };
        const receipt: MediaStorageReceipt = Object.freeze(destination.kind === 'file'
            ? { ...base, kind: 'file' as const, file: destination.file }
            : { ...base, kind: 'embedded' as const, file: null,
                async captureCurrentBytes(signal: AbortSignal) {
                    const current = active(); check(current); signal.throwIfAborted();
                    if (current.committedRevision === null || current.destination.kind !== 'embedded') throw new Error('Media must be committed before capturing its document');
                    const { runtime, context } = current.request, capturedRevision = runtime.session.doc.rev;
                    const captured = await current.destination.captureCurrentBytes(AbortSignal.any([signal, context.signal]));
                    try {
                        signal.throwIfAborted(); context.signal.throwIfAborted(); check(current);
                        if (captured.owner.documentId !== owner.documentId || captured.owner.session !== owner.session || captured.revision !== capturedRevision
                            || !(captured.bytes instanceof Blob || captured.bytes instanceof Uint8Array)
                            || typeof File !== 'undefined' && captured.bytes instanceof File) throw new TypeError('Current document capture belongs to another source or revision');
                        return captured;
                    } catch (error) { captured.release(); throw error; }
                } });
        issued.set(receipt, initial);
        return receipt;
    } catch (error) {
        state = null; hold.release();
        // Source retention transfers only on successful issuance; the caller
        // still owns its real PDF source lease on every throwing path here.
        throw error;
    }
}

export function assertMediaStorageReceipt(receipt: MediaStorageReceipt, request: MediaStorageRequest): void {
    const state = issued.get(receipt);
    if (!state || state.request.runtime !== request.runtime || state.request.context !== request.context
        || state.request.blob !== request.blob || state.request.inspection !== request.inspection
        || !matchingEntry(state.request.entry, request.entry)) throw new TypeError('Foreign or fabricated media storage receipt');
    check(state);
}

export function resolveMediaStorage(result: MediaStorageResult, request: MediaStorageRequest): {
    readonly file: string | null; readonly receipt: MediaStorageReceipt | null;
} {
    if (typeof result === 'string') {
        if (request.runtime.session.doc.kind === 'pdf-ink' || !isSafeMediaFile(result)) throw new TypeError('Embedded media requires a genuine source-owned receipt');
        return { file: result, receipt: null };
    }
    if (!result) throw new Error('Media bytes could not be stored');
    try { assertMediaStorageReceipt(result, request); }
    catch (error) {
        const state = issued.get(result);
        if (state?.request.runtime === request.runtime && state.request.context === request.context && state.request.blob === request.blob) result.release();
        throw error;
    }
    return { file: result.file, receipt: result };
}
