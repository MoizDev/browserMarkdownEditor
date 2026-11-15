import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import { DEFAULT_PAPER } from '../../utils/paper';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { SourceOwner } from '../../utils/documentBuffers';
import { Limiter } from '../../utils/pool';
import { joinVaultPath, parentVaultPath } from '../../utils/paths';
import { createSerializerSession } from '../format/serializerClient';
import type { EncoderContext, SavedView } from '../format/encode';
import type { PointSamples } from '../format/points';
import type { RecordVersion } from '../format/recordChanges';
import { MediaStore, type MediaLease } from '../media/store';
import { mediaExtension } from '../media/ingest';
import { MEDIA_MIMES, type MediaId, type MediaMime } from '../model/media';
import type { NodeId } from '../model/ids';
import { createBoardRenderServices } from '../render/services';
import { acquireNativeBoardFromHost } from './acquireFromHost';
import { createBoardEncoderBounds } from './encoderBounds';
import { createEmptyNativeBytes } from './emptyNative';
import { createBoardJournal } from './journal';
import { acquireLegacyBoard, type LegacyBoardAcquisition } from './legacyAcquisition';
import { createNativeMediaRestore } from './nativeMediaRestore';
import { createOwnedBoardRuntime, type OwnedBoardRuntime } from './ownedRuntime';
import { elbowAdmissionRefusal } from '../geom/elbowAdmission';
import { primeNativeLoad } from './primeNative';
import { restoreRecoveredMediaFromHost } from './recoverMediaFromHost';

export interface PrepareNativeRuntimeOptions {
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly representation: 'drawing' | 'notebook';
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
    readonly zMax: number;
    readonly sourcePin?: ReturnType<NativeCanvasHost['pinBoardSource']>;
    readonly savedView?: () => SavedView | undefined;
    onError(error: unknown): void;
    onHistoryLimit(): void;
}

let legacyMemorySerial = 0;

/** Preparation owns admission and creator leases until take transfers one runtime. */
export async function prepareNativeRuntime(options: PrepareNativeRuntimeOptions) {
    const { host, identity, signal } = options;
    if (identity.kind !== options.representation) throw new Error('Canvas representation does not match identity');
    const pinned = options.sourcePin ?? host.pinBoardSource(identity);
    let original: Blob, diskHash: string;
    try {
        const source = await pinned.read(signal);
        original = source.input; diskHash = source.diskHash;
        signal.throwIfAborted();
        if (!host.isCurrent(identity) || !pinned.isCurrent()) throw new DOMException('Canvas session ended', 'AbortError');
        if (pinned.dirty && original.size === 0) throw new Error('An unsaved empty canvas cannot be initialized as a new board.');
    } catch (error) { pinned.release(); throw error; }
    // Only verified zero-byte originals are new boards; parse failures never
    // authorize replacement by an invented document.
    let admitted: Awaited<ReturnType<typeof acquireNativeBoardFromHost>>;
    try {
        const boardBytes = original.size === 0 ? createEmptyNativeBytes(options.representation === 'drawing' ? 'whiteboard' : 'notebook') : original;
        admitted = await acquireNativeBoardFromHost(host, identity, { signal, deadlineMs: options.deadlineMs, boardBytes });
    }
    catch (error) { pinned.release(); throw error; }
    let media: MediaStore | undefined;
    let services: ReturnType<typeof createBoardRenderServices> | undefined;
    let serializer: ReturnType<typeof createSerializerSession> | undefined;
    const creatorLeases: MediaLease[] = [];
    let legacy: LegacyBoardAcquisition | undefined;
    let transferred = false, disposed = false, owned: OwnedBoardRuntime | undefined;
    const releaseCreators = () => { for (const lease of creatorLeases.splice(0)) lease.release(); };
    const disposePreparation = () => {
        if (disposed || transferred) return;
        disposed = true;
        pinned.release();
        releaseCreators();
        serializer?.dispose();
        services?.dispose();
        media?.clear();
        try { legacy?.dispose(); } finally { admitted.dispose(); }
    };
    try {
        let acquired = admitted.acquisition, nativeBytes = admitted.bytes;
        if (acquired.status === 'read-only' && acquired.report.format === 'other' && acquired.report.complete
            && acquired.report.bytesRead === original.size && original.size > 0) {
            const token = { vaultEpoch: identity.vaultActivation, documentId: identity.documentId,
                session: identity.session, bytesGeneration: identity.bytesGeneration };
            const job = { session: `${identity.documentId}:${identity.session}`, epoch: identity.vaultActivation,
                revision: identity.bytesGeneration };
            const now = performance.now();
            let live = 0;
            const cache = getPlatformRuntime().governor.register({ id: `legacy-acquisition:${identity.documentId}:${++legacyMemorySerial}`,
                owner: token, pool: 'cpu', kind: 'working', class: 'critical', hiddenAt: null,
                lastVisibleAt: now, lastUsedAt: now, memory: () => ({ live, retiring: 0 }), evict: () => {} });
            const memory = {
                reserve(bytes: number) { const lease = cache.reserve(bytes); if (lease) live += lease.bytes; return lease; },
                release(lease: Parameters<typeof cache.release>[0]) { cache.release(lease); live -= lease.bytes; },
            };
            try {
                legacy = await acquireLegacyBoard({ bytes: original, kind: options.representation === 'drawing' ? 'whiteboard' : 'notebook',
                    host: options.representation === 'drawing' ? { kind: 'whiteboard' }
                        : { kind: 'notebook', paper: { ...DEFAULT_PAPER }, ext: null },
                    token, zMax: options.zMax, memory, nativeReport: acquired.report, identity: job,
                    isCurrent: candidate => candidate.session === job.session && candidate.epoch === job.epoch
                        && candidate.revision === job.revision && host.isCurrent(identity),
                    readAsset: (src, assetSignal) => host.readLegacyAsset(identity, src, assetSignal), signal });
            } finally { cache.close(); }
            signal.throwIfAborted();
            if (!host.isCurrent(identity)) throw new DOMException('Canvas session ended', 'AbortError');
            if (legacy.status !== 'editable') {
                const issues = legacy.legacyReport.unrepresentable.map(issue => issue.reason).join('; ');
                throw new Error(`Legacy board could not be converted${issues ? `: ${issues}` : '.'}`);
            }
            acquired = legacy.native;
            nativeBytes = legacy.bytes;
        }
        if (acquired.status !== 'editable') {
            const issues = acquired.report.issues.map(issue => issue.reason).join('; ');
            throw new Error(`Board could not be opened for editing${issues ? `: ${issues}` : '.'}`);
        }
        const { load, samples } = acquired, doc = load.doc;
        media = new MediaStore();
        const store = media;
        if (legacy?.status === 'editable') for (const [id, blob] of legacy.media) {
            creatorLeases.push(store.retain(id, 'journal'));
            store.put(id, blob);
        }
        const references = new Set<MediaId>();
        for (const [id, refs] of doc.mediaRefs) if (refs.size) references.add(id);
        for (const [id, count] of doc.preservedMediaRefs) if (count > 0) references.add(id);
        const limiter = new Limiter();
        const mediaLoads = await Promise.allSettled([...references].map(id => limiter.run(async () => {
            signal.throwIfAborted();
            const entry = doc.media.get(id);
            if (!entry) return;
            if (legacy?.status === 'editable' && legacy.media.has(id)) return;
            const read = await admitted.media.read(entry, signal);
            signal.throwIfAborted();
            if (!read) return;
            creatorLeases.push(store.retain(id, 'journal'));
            store.put(id, read.blob);
            store.setFile(id, read.name);
        })));
        const failedMedia = mediaLoads.find(result => result.status === 'rejected');
        if (failedMedia?.status === 'rejected') throw failedMedia.reason;
        signal.throwIfAborted();
        if (!host.isCurrent(identity)) throw new DOMException('Canvas session ended', 'AbortError');
        const token = { vaultEpoch: identity.vaultActivation, documentId: identity.documentId,
            session: identity.session, bytesGeneration: identity.bytesGeneration };
        services = createBoardRenderServices({ doc, samples, media: store, token });
        const render = services;
        // Post-layout admission (document-model §9.2): an elbow connector with no valid route opens the board
        // read-only, on the real layout, before any editable transfer. A layout gap throws and fails closed.
        const admissionRefusal = elbowAdmissionRefusal(doc, render.changeGeometry);
        const bounds = await createBoardEncoderBounds({ doc, sources: load.sources, local: render.encoderLocal,
            realize: render.realize, geometryEpoch: () => render.text.fonts.epoch });
        const sourceNodes = new Set(load.sources.filter(source => source.category === 'node' && !source.reencode).map(source => source.id));
        const reencodedNodes = new Set(load.sources.filter(source => source.category === 'node' && source.reencode).map(source => source.id));
        const needsBounds: NodeId[] = [];
        for (const id of doc.nodes.keys()) if (!sourceNodes.has(id) || reencodedNodes.has(id)) needsBounds.push(id);
        await bounds.prepare(needsBounds, signal);
        const encoder: EncoderContext = {
            bounds: bounds.bounds, zMax: options.zMax,
            stroke(node): PointSamples {
                const sequence = samples.sequence(node.samples), count = sequence.count;
                const xy = new Float64Array(count * 2);
                const pressure = samples.pressureMode(node.samples) === 'real' ? new Float64Array(count) : null;
                const starts: number[] = [], kinds: number[] = [];
                for (let i = 0; i < count; i++) {
                    xy[2 * i] = sequence.x(i); xy[2 * i + 1] = sequence.y(i);
                    if (pressure) pressure[i] = sequence.pressure(i)!;
                    if (i + 1 < count) {
                        const kind = sequence.segmentKind(i) === 'straight' ? 1 : 0;
                        if (!kinds.length || kinds[kinds.length - 1] !== kind) { starts.push(i); kinds.push(kind); }
                    }
                }
                return { xy, pressure, runs: kinds.length ? { starts: Uint32Array.from(starts), kinds: Uint8Array.from(kinds) } : null };
            },
            readEncoded: node => samples.readEncoded(node.samples),
            savedView: () => options.savedView?.() ?? load.savedView,
            mediaRefs: doc.mediaRefs, preservedMediaRefs: doc.preservedMediaRefs,
        };
        const { prime, records } = await primeNativeLoad(load, nativeBytes, encoder, undefined, signal);
        if (!prime.lines) throw new Error('Native recovery needs an indexed initial baseline');
        const lines = prime.lines, overrides = prime.overrides ?? [];
        const initialRecords = function* (): IterableIterator<RecordVersion> {
            for (const line of lines) yield { identity: line.identity, revision: line.revision };
            for (const item of overrides) yield { identity: item.identity, revision: item.revision };
        };
        serializer = createSerializerSession(prime, options.onError,
            { session: `${identity.documentId}:${identity.session}`, epoch: identity.vaultActivation });
        const preparedSerializer = serializer;
        signal.throwIfAborted();
        await pinned.verify(signal);
        signal.throwIfAborted();
        if (!host.isCurrent(identity) || !pinned.isCurrent()) throw new DOMException('Canvas session ended', 'AbortError');
        return {
            legacyOriginalSha256: legacy?.status === 'editable' ? diskHash : null,
            conversionPending: legacy?.status === 'editable',
            acceptPinnedSource(source: import('../../utils/documentBuffers').DeferredSource) {
                try { if (pinned.dirty) { pinned.accept(source); return true; } return false; } finally { pinned.release(); }
            },
            media: store,
            runtime: () => owned?.runtime,
            take(owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean, readOnlyReason: () => string | null) {
                if (disposed || transferred) throw new Error('Native board preparation already consumed');
                signal.throwIfAborted();
                if (owner.documentId !== identity.documentId || owner.session !== identity.session || !isLiveOwner(owner) || !host.isCurrent(identity) || !pinned.isCurrent()) {
                    throw new DOMException('Canvas session ended', 'AbortError');
                }
                const journal = createBoardJournal({ doc, samples, capture: {
                    baseline: prime, doc, encoder, records: initialRecords(), representation: options.representation,
                    mediaPath(id) {
                        const current = host.identity(identity.documentId), entry = doc.media.get(id);
                        const filename = store.currentFile(id) ?? entry?.file;
                        if (!current || !host.isCurrent(identity) || !filename) return null;
                        return joinVaultPath(joinVaultPath(parentVaultPath(current.path), '.Assets'), filename);
                    },
                    mediaAsset(id) {
                        const entry = doc.media.get(id), blob = store.get(id);
                        if (!entry || !blob || !(MEDIA_MIMES as readonly string[]).includes(entry.mime)) return undefined;
                        // This names the reference encoded in the recipe, not a resolver's
                        // alternate disk location; copy restoration must detect and remap it.
                        return { id, hash: id.slice(7), extension: mediaExtension(entry.mime as MediaMime), file: entry.file, blob };
                    },
                    retainMedia: id => store.retain(id, 'journal'),
                }, append: (capture, source) => host.appendJournal(identity, source, capture),
                isCurrent: () => isLiveOwner(owner) && host.isCurrent(identity),
                assertDiskBaseline: async recoverySignal => { await host.acquireBytes(identity, recoverySignal); },
                prepareMedia: (payload, recoverySignal, current) =>
                    restoreRecoveredMediaFromHost(payload, host, identity, store, recoverySignal, current),
                onError: options.onError });
                try {
                    const pinMedia = createNativeMediaRestore(store, host, identity, () => owned?.board, store);
                    owned = createOwnedBoardRuntime({ runtime: { owner, doc, samples, media: store, render,
                        serializer: preparedSerializer, records, encoder, journal,
                        geometry: render.changeGeometry,
                        isCurrent: candidate => candidate.documentId === identity.documentId && candidate.session === identity.session
                            && isLiveOwner(candidate) && host.isCurrent(identity),
                        // Only the acquisition's temporary seal (and the App-immutable guards it wraps)
                        // may refuse writes. A permanent per-call reason here could never be cleared by
                        // activateEditing, so it is not an option (measured: cold agent stayed read-only).
                        // A document-derived refusal (planned §9.2 read-only) holds until reload; it is not the
                        // static per-call option removed earlier, which activateEditing could never clear.
                        readOnlyReason: () => admissionRefusal ?? readOnlyReason() ?? null,
                        onFailure: options.onError, onHistoryLimit: options.onHistoryLimit,
                        scene: { token, bounds: render.bounds, retainNode: render.retainNode, realize: render.realize,
                            preparePaint: render.preparePaint, preparePaintStream: render.preparePaintStream, subscribeInvalidation: render.subscribeInvalidation },
                    }, builds: { pinMedia } });
                    transferred = true;
                    releaseCreators();
                    try { legacy?.dispose(); } finally { admitted.dispose(); }
                    let closed = false;
                    return { board: owned.board, dispose() {
                        if (closed) return;
                        closed = true;
                        pinned.release();
                        try { owned?.dispose(); } finally { render.dispose(); }
                    } };
                } catch (error) { journal.dispose(); throw error; }
            },
            dispose: disposePreparation,
        };
    } catch (error) { disposePreparation(); throw error; }
}
