import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import type { ReserveOptions } from '../../platform/render/memoryGovernor';
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
import { MEDIA_MIMES, type MediaEntry, type MediaId, type MediaMime } from '../model/media';
import type { NodeId } from '../model/ids';
import { createBoardRenderServices } from '../render/services';
import { acquireNativeBoardFromHost } from './acquireFromHost';
import { createBoardEncoderBounds } from './encoderBounds';
import { createEmptyNativeBytes } from './emptyNative';
import { createBoardJournal } from './journal';
import { acquireLegacyBoard, type LegacyBoardAcquisition } from './legacyAcquisition';
import { groupIssueText, importFailure, importNotice } from '../import/report';
import { oldBoardReadOnlyReason } from '../../utils/oldBoards';
import type { NativeBoardCopySource, NativeOldBoard } from '../../types/nativeCanvas';
import { encodeMedia, encodeView } from '../format/encode';
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

let legacyMemorySerial = 0, derivedMemorySerial = 0;

/** Preparation owns admission and creator leases until take transfers one runtime. */
export async function prepareNativeRuntime(options: PrepareNativeRuntimeOptions) {
    const { host, identity, signal } = options;
    if (identity.kind !== options.representation) throw new Error('Canvas representation does not match identity');
    const pinned = options.sourcePin ?? host.pinBoardSource(identity);
    let original: Blob;
    try {
        const source = await pinned.read(signal);
        original = source.input;
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
                reserve(bytes: number, options?: ReserveOptions) { const lease = cache.reserve(bytes, options); if (lease) live += lease.bytes; return lease; },
                release(lease: Parameters<typeof cache.release>[0]) { cache.release(lease); live -= lease.bytes; },
                whenAvailable: (wake: () => void, bytes?: number) => cache.whenAvailable?.(wake, bytes),
            };
            try {
                legacy = await acquireLegacyBoard({ bytes: original, kind: options.representation === 'drawing' ? 'whiteboard' : 'notebook',
                    host: options.representation === 'drawing' ? { kind: 'whiteboard' }
                        : { kind: 'notebook', paper: { ...DEFAULT_PAPER }, ext: null },
                    token, zMax: options.zMax, memory, nativeReport: acquired.report, identity: job, loadKey: identity.documentId,
                    isCurrent: candidate => candidate.session === job.session && candidate.epoch === job.epoch
                        && candidate.revision === job.revision && host.isCurrent(identity),
                    readAsset: (src, assetSignal) => host.readLegacyAsset(identity, src, assetSignal), signal });
            } finally { cache.close(); }
            signal.throwIfAborted();
            if (!host.isCurrent(identity)) throw new DOMException('Canvas session ended', 'AbortError');
            if (legacy.status !== 'editable') throw new Error(importFailure(`This ${options.representation} from an older version of the app could not be read`, legacy.legacyReport.unrepresentable));
            acquired = legacy.native;
            nativeBytes = legacy.bytes;
        }
        if (acquired.status !== 'editable') {
            const issues = groupIssueText(acquired.report.issues.map(issue => issue.reason));
            throw new Error(`Board could not be opened for editing${issues ? `: ${issues}.` : '.'}`);
        }
        const { load, samples } = acquired, doc = load.doc;
        media = new MediaStore();
        const store = media;
        if (legacy?.status === 'editable') for (const [id, blob] of legacy.media) {
            creatorLeases.push(store.retain(id, 'journal'));
            store.put(id, blob);
        }
        // An old-format board is shown exactly as the importer read it and never written: its runtime is sealed read-only
        // for life (no edit, recovery, agent change or save can reach the file), and the board in memory is what an
        // editable copy is made from. Its pictures are held here too: the store drops a picture no view holds and reads it
        // again from `.Assets`, where an old board's pictures have never been written.
        const oldPictures = legacy?.status === 'editable' ? [...legacy.media] : undefined;
        const oldReason = legacy ? oldBoardReadOnlyReason(options.representation) : null;
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
        // Stroke LOD levels and idle geometry are rebuildable from the samples and document, so the governor may reclaim them first (`redundant-level`).
        services = createBoardRenderServices({ doc, samples, media: store, token, derivedMemory: evict => {
            // The governor reads `memory()` while publishing its readout, so the live count is kept here, not read back.
            let live = 0;
            const now = performance.now();
            // Named for what it holds (idle geometry and stroke LOD levels). It has no pane, so it is charged to the pool only.
            const cache = getPlatformRuntime().governor.register({ id: `derived-geometry:${identity.documentId}:${++derivedMemorySerial}`,
                owner: token, pool: 'cpu', kind: 'working', class: 'redundant-level', hiddenAt: null,
                lastVisibleAt: now, lastUsedAt: now, memory: () => ({ live, retiring: 0 }), evict });
            return {
                reserve(bytes: number) { const lease = cache.reserve(bytes); if (lease) live += lease.bytes; return lease; },
                release(lease: Parameters<typeof cache.release>[0]) { cache.release(lease); live -= lease.bytes; },
                close: () => cache.close(),
            };
        } });
        const render = services;
        // Post-layout admission (document-model §9.2): an elbow connector with no valid route opens the board
        // read-only, on the real layout, before any editable transfer. A layout gap throws and fails closed.
        // Routing measures connector targets' text, so their faces must be loaded first; without
        // this every received board with an elbow connector and text failed to open.
        const elbows = [...doc.nodes.values()].filter(node => node.kind === 'connector' && node.route === 'elbow').map(node => node.id);
        if (elbows.length) { await render.prepareChangeGeometry(elbows, signal); signal.throwIfAborted(); }
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
        const legacyReport = legacy?.status === 'editable' ? legacy.legacyReport : undefined;
        const oldBoard: NativeOldBoard | undefined = oldPictures && legacyReport ? {
            kind: options.representation,
            notice: importNotice(legacyReport, leftOut => leftOut === 0 ? 'The file itself is never changed.'
                : `${leftOut === 1 ? 'It is' : 'They are'} still in the file, which is never changed.`),
            copyNotice: importNotice(legacyReport, leftOut => leftOut === 0 ? 'The original is unchanged.'
                : `This copy keeps ${leftOut === 1 ? 'it' : 'them'} in its file, and the original is unchanged.`),
            async copySource(copySignal, view): Promise<NativeBoardCopySource> {
                copySignal.throwIfAborted();
                if (!owned?.board || !host.isCurrent(identity)) throw new DOMException('Canvas session ended', 'AbortError');
                const pictures: { entry: MediaEntry; hash: string; extension: string; blob: Blob }[] = [];
                for (const [id, blob] of oldPictures) {
                    const entry = doc.media.get(id);
                    if (!entry || !(MEDIA_MIMES as readonly string[]).includes(entry.mime)) continue;
                    if (!doc.mediaRefs.get(id)?.size && !(doc.preservedMediaRefs.get(id) ?? 0)) continue;
                    pictures.push({ entry, hash: id.slice(7), extension: mediaExtension(entry.mime as MediaMime), blob });
                }
                return {
                    media: pictures.map(({ hash, extension, blob }) => ({ hash, extension, blob })),
                    // The serializer's own build of the board in memory (the importer's records, with the bounds and text
                    // layout this runtime measured), never a second read and import of the file. Each picture record names
                    // the file the copy stored it in, as a save's media restore would have (encodeMedia keeps its extras),
                    // so the copy's first save has nothing to rename. Not the session's checkpoint: that restores the
                    // pictures into the ORIGINAL's folder as a write of its session, which an old board's session refuses.
                    async build(files, buildSignal) {
                        const overrides = [];
                        for (const picture of pictures) {
                            const file = files.get(picture.hash);
                            if (!file) throw new Error('A picture of the copy has no file.');
                            if (picture.entry.file === file) continue;
                            const encoded = encodeMedia({ ...picture.entry, file });
                            if (!encoded.ok) throw new Error(encoded.error.reason);
                            overrides.push({ identity: encoded.value.identity, bytes: new TextEncoder().encode(encoded.value.text) });
                        }
                        // A drawing's copy opens where the person was looking at the original: its own view record, read as
                        // any drawing's saved view is (viewCamera.ts), which still frames the content if that view shows none.
                        if (view && doc.kind === 'whiteboard' && [...doc.sheets.keys()].some(id => id === view.sheet)
                            && [view.x, view.y, view.zoom].every(Number.isFinite) && view.zoom > 0) {
                            const encoded = encodeView(doc.view, { sheet: view.sheet, x: view.x, y: view.y, zoom: view.zoom });
                            if (!encoded.ok) throw new Error(encoded.error.reason);
                            overrides.push({ identity: encoded.value.identity, bytes: new TextEncoder().encode(encoded.value.text) });
                        }
                        buildSignal.throwIfAborted();
                        const built = await preparedSerializer.checkpoint(records.integrity(), doc.preserved.end, overrides).build(buildSignal);
                        return built instanceof Blob ? built : new Blob([built.slice().buffer as ArrayBuffer]);
                    },
                };
            },
        } : undefined;
        return {
            legacyOriginalSha256: null,
            ...(oldBoard ? { oldBoard } : {}),
            // What the import left out, said once in the original's own notice (and, by its copy, in the copy's).
            importNotice: oldBoard?.notice ?? null,
            acceptPinnedSource(source: import('../../utils/documentBuffers').DeferredSource) {
                // An old board's buffer is never edited (documentReading.ts), so a dirty pin of one is not a source to accept.
                try { if (pinned.dirty && !oldBoard) { pinned.accept(source); return true; } return false; } finally { pinned.release(); }
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
                        // A picture read from a tldraw-format file has no file of its own yet (`file: null`, the content-addressed
                        // name its first save writes). Without that default the first stroke on any old board holding a picture
                        // failed its recovery capture, and the pane fell to "Could not open canvas: Recovery media path unavailable".
                        const filename = store.currentFile(id) ?? entry?.file
                            ?? (entry && (MEDIA_MIMES as readonly string[]).includes(entry.mime) ? `${id.slice(7)}.${mediaExtension(entry.mime as MediaMime)}` : null);
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
                    // A build first restores the board's pictures into its own folder and records their names, as a write of
                    // this session. An old board's session never writes, and its copy stores the pictures beside itself
                    // (useEditableCopy), so its build leaves them as the import named them: by content, `file: null`.
                    const pinMedia = oldBoard ? () => ({ restore: async () => 'unchanged' as const, release() {} })
                        : createNativeMediaRestore(store, host, identity, () => owned?.board, store);
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
                        readOnlyReason: () => oldReason ?? admissionRefusal ?? readOnlyReason() ?? null,
                        onFailure: options.onError, onHistoryLimit: options.onHistoryLimit,
                        scene: { token, bounds: render.bounds, retainNode: render.retainNode, realize: render.realize,
                            preparePaint: render.preparePaint, preparePaintStream: render.preparePaintStream, subscribeInvalidation: render.subscribeInvalidation },
                    }, builds: { pinMedia } });
                    transferred = true;
                    releaseCreators();
                    try { legacy?.dispose(); } finally { admitted.dispose(); }
                    let closing: Promise<void> | undefined;
                    return { board: owned.board, dispose() {
                        // Revocation is immediate; the pinned native source and render services stay until the
                        // runtime's builds have settled, because those builds read them.
                        closing ??= (async () => {
                            try { await owned?.dispose(); } finally { pinned.release(); render.dispose(); }
                        })();
                        return closing;
                    } };
                } catch (error) { journal.dispose(); throw error; }
            },
            dispose: disposePreparation,
        };
    } catch (error) { disposePreparation(); throw error; }
}
