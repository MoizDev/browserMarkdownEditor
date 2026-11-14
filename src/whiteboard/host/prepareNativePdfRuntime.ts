import type { createPdfInkHost, pinPdfInkHostForSave, readPdfInkLegacyDigest, validateLoadedPdfInkHost } from '../../pdf/session/inkHost';
import type { PdfEditableInkSource } from '../../pdf/session/inkAcquisition.types';
import type { RenderToken } from '../../platform/render/types';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { SourceOwner } from '../../utils/documentBuffers';
import { Limiter } from '../../utils/pool';
import type { EncoderContext, SavedView } from '../format/encode';
import type { PointSamples } from '../format/points';
import type { RecordVersion } from '../format/recordChanges';
import { boardRecoveryMedia } from '../format/recoveryRecipe';
import { createSerializerSession } from '../format/serializerClient';
import { mediaExtension } from '../media/ingest';
import { hashMedia } from '../media/sha256';
import { MediaStore, type MediaLease } from '../media/store';
import { MEDIA_MIMES, type MediaId, type MediaMime } from '../model/media';
import type { NodeId } from '../model/ids';
import { createBoardRenderServices } from '../render/services';
import { createBoardEncoderBounds } from './encoderBounds';
import { createEmptyNativeBytes } from './emptyNative';
import { createBoardJournal } from './journal';
import { acquireNativeBoard } from './nativeAcquisition';
import { createOwnedBoardRuntime, type OwnedBoardRuntime } from './ownedRuntime';
import { createPdfInkBuildCapture } from './pdfInkBuildCapture';
import { createPdfInkSourceOwner } from './pdfInkSourceOwner';
import { inspectPdfVisualModel } from './pdfVisualPreflight';
import { primeNativeLoad } from './primeNative';

type SourceOwnerPort = ReturnType<typeof createPdfInkSourceOwner>;
type WrittenPdf = ReturnType<ReturnType<typeof createPdfInkBuildCapture>['writtenContext']>;
export interface PrepareNativePdfRuntimeOptions {
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    /** Ownership transfers on entry, including on preparation failure. */
    readonly accepted: PdfEditableInkSource;
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
    readonly zMax: number;
    readonly createHost: typeof createPdfInkHost;
    readonly validateLoadedHost: typeof validateLoadedPdfInkHost;
    readonly readLegacyDigest: typeof readPdfInkLegacyDigest;
    readonly pinHost: typeof pinPdfInkHostForSave;
    readonly currentReadOnly: () => string | null;
    readonly afterWritten: (revision: number, written: WrittenPdf, sources: SourceOwnerPort) => void | Promise<void>;
    readonly savedView?: () => SavedView | undefined;
    onError(error: unknown): void;
    onHistoryLimit(): void;
}

/** A PDF acquisition and native board share one owner and one mutable document. */
export async function prepareNativePdfRuntime(options: PrepareNativePdfRuntimeOptions) {
    const { host, identity, accepted, signal } = options;
    const tokenCurrent = (token: RenderToken) => {
        if (token.documentId !== identity.documentId || token.session !== identity.session || token.vaultEpoch !== identity.vaultActivation) return false;
        const source = host.identity(identity.documentId), outer = host.outerIdentity(identity.documentId);
        return !!source && !!outer && source.kind === 'pdfInk' && outer.kind === 'pdfInk'
            && source.documentId === token.documentId && outer.documentId === token.documentId
            && source.session === token.session && outer.session === token.session
            && source.vaultActivation === token.vaultEpoch && outer.vaultActivation === token.vaultEpoch
            && source.bytesGeneration <= token.bytesGeneration && token.bytesGeneration <= outer.bytesGeneration
            && host.isCurrent(source) && host.isCurrent(outer);
    };
    let sources: SourceOwnerPort;
    try {
        if (identity.kind !== 'pdfInk' || !host.isCurrent(identity) || !tokenCurrent(accepted.source.token)) throw new Error('PDF source owner does not match the canvas');
        sources = createPdfInkSourceOwner(accepted, { currentOwner: tokenCurrent, onError: options.onError });
    } catch (error) { await accepted.release(); throw error; }
    let acquired: Awaited<ReturnType<typeof acquireNativeBoard>> | undefined;
    let media: MediaStore | undefined, render: ReturnType<typeof createBoardRenderServices> | undefined;
    let serializer: ReturnType<typeof createSerializerSession> | undefined, owned: OwnedBoardRuntime | undefined;
    const creators: MediaLease[] = [];
    const verifiedMedia = new WeakMap<Blob, MediaId>();
    let disposed = false, transferred = false, cleanup: Promise<void> | undefined;
    const releaseCreators = () => { for (const lease of creators.splice(0)) lease.release(); };
    const close = () => {
        if (cleanup) return cleanup;
        disposed = true;
        cleanup = (async () => {
            const failures: unknown[] = [];
            const run = (action: () => void) => { try { action(); } catch (error) { failures.push(error); } };
            run(() => owned?.dispose());
            run(releaseCreators); run(() => serializer?.dispose()); run(() => render?.dispose());
            run(() => media?.clear()); run(() => acquired?.dispose()); run(() => sources.dispose());
            try { await sources.drain(); } catch (error) { failures.push(error); }
            if (failures.length) throw new AggregateError(failures, 'PDF runtime cleanup failed');
        })();
        return cleanup;
    };
    const dispose = () => transferred ? Promise.resolve() : close();
    const check = () => {
        signal.throwIfAborted();
        if (!host.isCurrent(identity) || !accepted.isCurrent()) throw new DOMException('PDF canvas session ended', 'AbortError');
    };
    try {
        check();
        const bytes = accepted.kind === 'plain' ? createEmptyNativeBytes('pdf-ink', { pdfHost: options.createHost(accepted) }) : accepted.board;
        acquired = await acquireNativeBoard({ bytes, kind: 'pdf-ink', signal, deadlineMs: options.deadlineMs,
            pdfPages: accepted.pages.map(page => [page.width, page.height] as const),
            identity: { session: `${identity.documentId}:${identity.session}`, epoch: identity.vaultActivation, generation: identity.bytesGeneration } });
        check();
        if (acquired.status !== 'editable') throw new Error('PDF ink board could not be admitted for editing');
        const { load, samples } = acquired, doc = load.doc;
        if (doc.kind !== 'pdf-ink' || !options.validateLoadedHost(accepted, doc.host)) throw new Error('PDF ink host does not match its inspected source');
        const legacyOriginalSha256 = accepted.kind === 'native' ? options.readLegacyDigest(accepted, doc.host) : null;
        const visual = await inspectPdfVisualModel(load, { signal });
        check();
        if (visual.status !== 'known') throw new Error('This PDF contains ink that cannot be safely displayed or rewritten. Open it in the PDF reader instead.');
        media = new MediaStore();
        const store = media, limiter = new Limiter();
        const loads = await Promise.allSettled([...doc.media.values()].map(entry => limiter.run(async () => {
            check();
            if (entry.file !== null || !(MEDIA_MIMES as readonly string[]).includes(entry.mime) || !/^sha256:[0-9a-f]{64}$/.test(entry.id)) throw new Error('Invalid PDF ink embedded media identity');
            const name = `board-media/${entry.id.slice(7)}.${mediaExtension(entry.mime as MediaMime)}`;
            const blob = await accepted.readMedia(name, signal);
            check();
            if (blob.size !== entry.bytes || await hashMedia(blob, signal) !== entry.id) throw new Error(`PDF ink media is corrupt: ${entry.id}`);
            verifiedMedia.set(blob, entry.id);
            creators.push(store.retain(entry.id, 'journal')); store.put(entry.id, blob); store.setFile(entry.id, entry.file);
        })));
        const failed = loads.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        for (const [id, refs] of doc.mediaRefs) if (refs.size && !doc.media.has(id)) throw new Error(`PDF ink media is missing: ${id}`);
        for (const [id, count] of doc.preservedMediaRefs) if (count > 0 && !doc.media.has(id)) throw new Error(`PDF preserved media is missing: ${id}`);
        check();
        const token = { vaultEpoch: identity.vaultActivation, documentId: identity.documentId,
            session: identity.session, bytesGeneration: identity.bytesGeneration };
        render = createBoardRenderServices({ doc, samples, media: store, token });
        const services = render;
        const bounds = await createBoardEncoderBounds({ doc, sources: load.sources, local: services.encoderLocal,
            realize: services.realize, geometryEpoch: () => services.text.fonts.epoch });
        const existing = new Set(load.sources.filter(source => source.category === 'node' && !source.reencode).map(source => source.id));
        const reencoded = new Set(load.sources.filter(source => source.category === 'node' && source.reencode).map(source => source.id));
        const needsBounds: NodeId[] = [];
        for (const id of doc.nodes.keys()) if (!existing.has(id) || reencoded.has(id)) needsBounds.push(id);
        await bounds.prepare(needsBounds, signal);
        const encoder: EncoderContext = {
            bounds: bounds.bounds, zMax: options.zMax,
            stroke(node): PointSamples {
                const sequence = samples.sequence(node.samples), count = sequence.count;
                const xy = new Float64Array(count * 2), pressure = samples.pressureMode(node.samples) === 'real' ? new Float64Array(count) : null;
                const starts: number[] = [], kinds: number[] = [];
                for (let i = 0; i < count; i++) {
                    xy[2 * i] = sequence.x(i); xy[2 * i + 1] = sequence.y(i);
                    if (pressure) pressure[i] = sequence.pressure(i)!;
                    if (i + 1 < count) { const kind = sequence.segmentKind(i) === 'straight' ? 1 : 0;
                        if (!kinds.length || kinds[kinds.length - 1] !== kind) { starts.push(i); kinds.push(kind); } }
                }
                return { xy, pressure, runs: kinds.length ? { starts: Uint32Array.from(starts), kinds: Uint8Array.from(kinds) } : null };
            },
            readEncoded: node => samples.readEncoded(node.samples), savedView: () => options.savedView?.() ?? load.savedView,
            mediaRefs: doc.mediaRefs, preservedMediaRefs: doc.preservedMediaRefs,
        };
        const { prime, records } = await primeNativeLoad(load, bytes, encoder, undefined, signal);
        if (!prime.lines) throw new Error('PDF ink recovery requires an indexed baseline');
        const lines = prime.lines, overrides = prime.overrides ?? [];
        const initialRecords = function* (): IterableIterator<RecordVersion> {
            for (const line of lines) yield { identity: line.identity, revision: line.revision };
            for (const item of overrides) yield { identity: item.identity, revision: item.revision };
        };
        serializer = createSerializerSession(prime, options.onError, { session: `${identity.documentId}:${identity.session}`, epoch: identity.vaultActivation });
        const preparedSerializer = serializer;
        check();
        return {
            sources, media: store, legacyOriginalSha256,
            runtime: () => owned?.runtime,
            take(owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean, readOnlyReason: () => string | null) {
                if (disposed || transferred) throw new Error('PDF preparation already consumed');
                try {
                    check();
                    if (owner.documentId !== identity.documentId || owner.session !== identity.session || !isLiveOwner(owner)) throw new DOMException('PDF session ended', 'AbortError');
                } catch (error) { void dispose(); throw error; }
                const current = () => isLiveOwner(owner) && host.isCurrent(identity);
                const build = createPdfInkBuildCapture({ runtime: () => {
                    if (!owned) throw new Error('PDF runtime is not ready'); return owned.runtime;
                }, sources, pinHost: options.pinHost, currentOwner: current, onError: options.onError });
                let journal: ReturnType<typeof createBoardJournal> | undefined;
                try {
                journal = createBoardJournal({ doc, samples, capture: {
                    baseline: prime, doc, encoder, records: initialRecords(), representation: 'pdf-ink',
                    mediaPath: () => null,
                    mediaAsset(id) {
                        const entry = doc.media.get(id), blob = store.get(id);
                        if (!entry || !blob || !(MEDIA_MIMES as readonly string[]).includes(entry.mime)) return undefined;
                        return { id, hash: id.slice(7), extension: mediaExtension(entry.mime as MediaMime), file: entry.file, blob };
                    },
                    retainMedia: id => store.retain(id, 'journal'), pdfCopy: build.pdfCopy,
                }, append: (capture, source) => host.appendJournal(identity, source, capture), isCurrent: current,
                    assertDiskBaseline: async recoverySignal => { await host.acquireBytes(identity, recoverySignal); },
                    async prepareMedia(payload, recoverySignal, isCurrent) {
                        const leases: MediaLease[] = [];
                        try {
                            for (const asset of boardRecoveryMedia(payload)) {
                                recoverySignal.throwIfAborted();
                                if (asset.file !== null || !isCurrent() || await hashMedia(asset.blob, recoverySignal) !== asset.id || !isCurrent()) throw new Error('Recovered PDF embedded media is invalid');
                                const id = asset.id as MediaId;
                                verifiedMedia.set(asset.blob, id);
                                leases.push(store.retain(id, 'journal')); store.put(id, asset.blob);
                            }
                            return { files: new Map<MediaId, string>(), release() { for (const lease of leases) lease.release(); } };
                        } catch (error) { for (const lease of leases) lease.release(); throw error; }
                    }, onError: options.onError });
                    owned = createOwnedBoardRuntime({ runtime: { owner, doc, samples, media: store, render: services,
                        serializer: preparedSerializer, records, encoder, journal, geometry: services.changeGeometry,
                        isCurrent: candidate => candidate.documentId === owner.documentId && candidate.session === owner.session && current(),
                        readOnlyReason: () => readOnlyReason() ?? options.currentReadOnly(), captureBuild: build.captureBuild,
                        afterWritten: (revision, context) => options.afterWritten(revision, build.writtenContext(revision, context), sources),
                        onFailure: options.onError, onHistoryLimit: options.onHistoryLimit,
                        scene: { token, bounds: services.bounds, retainNode: services.retainNode, realize: services.realize,
                            preparePaint: services.preparePaint, subscribeInvalidation: services.subscribeInvalidation },
                    }, builds: { pinMedia: () => {
                        const held: Array<{ id: MediaId; bytes: number; blob: Blob; lease: MediaLease }> = [];
                        try {
                            for (const entry of doc.media.values()) {
                                const blob = store.get(entry.id);
                                if (entry.file !== null || store.currentFile(entry.id) !== null || !blob || blob.size !== entry.bytes) {
                                    throw new Error(`PDF embedded media is unavailable: ${entry.id}`);
                                }
                                held.push({ id: entry.id, bytes: entry.bytes, blob, lease: store.retain(entry.id, 'snapshot') });
                            }
                        } catch (error) { for (const item of held) item.lease.release(); throw error; }
                        let released = false;
                        return {
                            async restore(restoreSignal) {
                                for (const item of held) {
                                    restoreSignal.throwIfAborted();
                                    if (released || !current() || item.blob.size !== item.bytes) throw new Error(`PDF embedded media is unavailable: ${item.id}`);
                                    if (verifiedMedia.get(item.blob) !== item.id) {
                                        if (await hashMedia(item.blob, restoreSignal) !== item.id) throw new Error(`PDF embedded media is corrupt: ${item.id}`);
                                        verifiedMedia.set(item.blob, item.id);
                                    }
                                }
                                restoreSignal.throwIfAborted();
                                if (released || !current()) throw new DOMException('PDF session ended', 'AbortError');
                                return 'unchanged';
                            },
                            release() { if (!released) { released = true; for (const item of held) item.lease.release(); } },
                        };
                    }, pinPdf: build.pinPdf } });
                    releaseCreators(); acquired?.dispose();
                    transferred = true;
                    return { board: owned.board, sources, dispose: close };
                } catch (error) {
                    try { journal?.dispose(); } finally { void close(); }
                    throw error;
                }
            }, dispose,
        };
    } catch (error) { await dispose(); throw error; }
}
