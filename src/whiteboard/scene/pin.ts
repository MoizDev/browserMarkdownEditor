import { FULL_REGION_CHANGES, type RegionChanges } from './boundsVersions';
import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc, BoardDocInput } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import { createLoadedBoardDoc } from '../model/loadDocument';
import { boardPageStack } from '../model/pages';
import type { PaintNode, PaintNodeSource } from '../render/paintStream';
import type { Rect } from '../../platform/types';
import type { ScenePaintNodeStream } from '../render/scenePaintStream';
import type { ResolvedNodeCache } from '../render/resolvedNodeCache';
import type { PaintNodeOrder } from '../render/paintOrder';
import { BoundsQuality, validBox } from './bounds';
import { createPinnedPaintDoc } from './paintDoc';
import { SceneCellIndex } from './cellIndex';
import type { SceneRecordPin } from './recordStore';
import type { SceneMetadata } from './snapshotDoc';
import type { SceneBounds, SceneOccupiedBounds, ScenePaintRequest, SceneSnapshot } from './types';

// Provenance: scene pin, rendering token and model snapshot contracts;
// independent immutable read-side assembly, no third-party source.
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
        && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function cancelled(): DOMException { return new DOMException('Scene snapshot cancelled', 'AbortError'); }
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason ?? cancelled());
    return new Promise<T>((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason ?? cancelled()); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) abort();
    });
}

/** The record pin owns its retained node/sample versions until release. The materialized
 * document is a private read side, never a second session or mutation authority. */
export function createSceneSnapshot(options: {
    token: RenderToken;
    revision: number;
    records: SceneRecordPin;
    metadata: SceneMetadata;
    bounds?: ReadonlyMap<NodeId, SceneBounds>;
    occupiedBounds?: SceneOccupiedBounds | null;
    /** Changed regions between an older revision and this pin; absent means unknown. */
    changes?: (from: number) => RegionChanges;
    renderer?: { release(): void };
    prepare: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, orderedIds?: PaintNodeOrder) => Promise<PaintNodeSource>;
    prepareStream?: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, orderedIds?: PaintNodeOrder, resolved?: ResolvedNodeCache) => ScenePaintNodeStream;
    cooperate?: () => Promise<void>;
    onError?: (error: unknown) => void;
}): SceneSnapshot {
    const token: RenderToken = Object.freeze({ ...options.token }), revision = options.revision;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(token.vaultEpoch) || token.vaultEpoch < 0
        || !Number.isSafeInteger(token.bytesGeneration) || token.bytesGeneration < 0 || !Number.isSafeInteger(token.session) || token.session < 0
        || typeof token.documentId !== 'string' || !token.documentId) throw new TypeError('Invalid scene snapshot identity');
    const controller = new AbortController(), { records, metadata } = options;
    const nodeCount = records.nodeCount;
    const supplied = options.occupiedBounds;
    const occupiedBounds = supplied?.revision === revision && validBox(supplied.bounds)
        ? Object.freeze({ revision, bounds: Object.freeze([...supplied.bounds] as [number, number, number, number]) }) : null;
    let released = false, building: Promise<BoardDoc> | undefined, paintDoc: BoardDoc | undefined, closing: Promise<void> | undefined;
    const inFlight = new Set<Promise<unknown>>();
    const streams = new Set<() => Promise<void>>();
    const check = () => { if (released || controller.signal.aborted) throw cancelled(); };
    const track = <T,>(promise: Promise<T>): Promise<T> => {
        inFlight.add(promise);
        void promise.then(() => { inFlight.delete(promise); }, () => { inFlight.delete(promise); });
        return promise;
    };
    const paintDocument = (): BoardDoc => { check(); return paintDoc ??= createPinnedPaintDoc(records, metadata, revision, check); };
    // The index is built once per pinned sheet in bounded slices; every stream and frame of this pin
    // then visits candidate ordinals only. A pending build is part of the pin, never a silent miss.
    const built: SceneCellIndex[] = [];
    const indexes = new Map<SheetId, Promise<SceneCellIndex>>(), ready = new Map<SheetId, SceneCellIndex>();
    const cooperateSlice = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const buildIndex = async (sheetId: SheetId): Promise<SceneCellIndex> => {
        const index = new SceneCellIndex();
        try {
            const stack: Iterator<import('../model/nodes').Node>[] = [records.children(sheetId)[Symbol.iterator]()];
            // A build is whole-sheet work, so its slices are sized for throughput: 2048 nodes or 4 ms, never
            // one host task per 64 nodes, which would make a million-node index spend most of its time yielding.
            let visited = 0, started = performance.now();
            while (stack.length) {
                check();
                if (++visited >= 2048 || performance.now() - started >= 4) {
                    await cooperateSlice(); check(); visited = 0; started = performance.now();
                }
                const next = stack[stack.length - 1].next();
                if (next.done) { stack.pop(); continue; }
                const node = next.value, bounds = options.bounds?.get(node.id);
                const usable = bounds?.revision === revision && (bounds.quality === BoundsQuality.Exact || bounds.quality === BoundsQuality.Conservative)
                    && bounds.ink && validBox(bounds.ink) ? bounds.ink : null;
                index.add(node.id, usable);
                if (records.childCount(node.id)) {
                    if (stack.length >= 65) throw new RangeError('Invalid scene parent depth');
                    stack.push(records.children(node.id)[Symbol.iterator]());
                }
            }
            check();
            built.push(index); ready.set(sheetId, index);
            return index;
        } catch (error) { index.close(); throw error; }
    };
    const indexFor = (sheetId: SheetId): Promise<SceneCellIndex> => {
        check();
        let pending = indexes.get(sheetId);
        if (!pending) {
            pending = track(buildIndex(sheetId));
            indexes.set(sheetId, pending);
            pending.catch(() => { if (indexes.get(sheetId) === pending) indexes.delete(sheetId); });
        }
        return pending;
    };
    const ordered = function* (index: SceneCellIndex, request: ScenePaintRequest): Generator<NodeId | null> {
        check();
        const world = request.world;
        const cull = world && [world.x, world.y, world.width, world.height, world.x + world.width, world.y + world.height]
            .every(Number.isFinite) && world.width >= 0 && world.height >= 0 ? world : undefined;
        let visited = 0, started = performance.now();
        for (const ordinal of index.candidates(cull)) {
            if (++visited >= 64 || performance.now() - started >= 0.25) {
                yield null; check(); visited = 0; started = performance.now();
            }
            const id = index.ids[ordinal], bounds = cull ? options.bounds?.get(id) : undefined;
            const usable = bounds?.revision === revision && (bounds.quality === BoundsQuality.Exact || bounds.quality === BoundsQuality.Conservative)
                && bounds.ink;
            if (request.only && !request.only.has(id)) continue;
            if (!cull || !usable || !(usable[2] < cull.x || usable[0] > cull.x + cull.width
                || usable[3] < cull.y || usable[1] > cull.y + cull.height)) yield id;
        }
    };
    const copyRequest = (request: ScenePaintRequest): ScenePaintRequest => Object.freeze({ ...request,
        ...(request.world ? { world: Object.freeze({ ...request.world }) } : {}),
        ...(request.sensitiveNodes ? { sensitiveNodes: new Set(request.sensitiveNodes) } : {}),
        ...(request.only ? { only: new Set(request.only) } : {}) });
    const regionChangesSince = (from: number): RegionChanges => options.changes ? options.changes(from) : FULL_REGION_CHANGES;
    /** Whether any sensitive node may paint inside `world`. Cell candidates answer it; a query too large
     * for the grid tests each sensitive node's own bounds instead. Unknown answers true. */
    const sensitiveMayMeet = (index: SceneCellIndex, world: Readonly<Rect>, sensitive: ReadonlySet<string>): boolean => {
        if (!sensitive.size) return false;
        try {
            if (index.countCandidates(world) < index.ids.length) {
                for (const ordinal of index.candidates(world)) if (sensitive.has(index.ids[ordinal])) return true;
                return false;
            }
        } catch { return true; }
        const pinned = options.bounds;
        if (!pinned) return true;
        for (const id of sensitive) {
            const value = pinned.get(id as NodeId);
            if (value === undefined) continue;
            const ink = value.ink;
            if (!ink || value.quality === BoundsQuality.Pending || value.quality === BoundsQuality.ColdLayout) return true;
            if (ink[0] <= world.x + world.width && world.x <= ink[2] && ink[1] <= world.y + world.height && world.y <= ink[3]) return true;
        }
        return false;
    };
    const occupiedRoot: Readonly<Rect> | undefined = occupiedBounds ? Object.freeze({ x: occupiedBounds.bounds[0], y: occupiedBounds.bounds[1],
        width: occupiedBounds.bounds[2] - occupiedBounds.bounds[0], height: occupiedBounds.bounds[3] - occupiedBounds.bounds[1] }) : undefined;
    const mayPaint = (index: SceneCellIndex, world: Readonly<Rect>): boolean => {
        try { return index.countCandidates(world) > 0; } catch { return true; }
    };
    const wrapStream = (source: ScenePaintNodeStream, signal: AbortSignal, local: AbortController, sourceWorld: Readonly<Rect> | undefined, index: SceneCellIndex): ScenePaintNodeStream => {
        let next: Promise<PaintNode | null> | undefined, closePromise: Promise<void> | undefined;
        const close = (): Promise<void> => {
            if (closePromise) return closePromise;
            closePromise = Promise.resolve().then(async () => {
                local.abort(cancelled());
                const pending = next;
                const retiring = Promise.resolve().then(() => source.release());
                const [result] = await Promise.allSettled(pending ? [retiring, pending] : [retiring]);
                if (result.status === 'rejected') throw result.reason;
                signal.removeEventListener('abort', abort);
                streams.delete(close);
            });
            return closePromise;
        };
        const abort = () => { void close().catch(error => { try { options.onError?.(error); } catch { /* Preserve retirement failure. */ } }); };
        streams.add(close);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        return {
            token: source.token, theme: source.theme, sceneRevision: source.sceneRevision, sourceDoc: source.sourceDoc, sensitiveNodes: source.sensitiveNodes,
            sessionRasters: source.sessionRasters, get rasterVariant() { return source.rasterVariant; }, sourceWorld, regionChangesSince,
            sensitiveMayMeet: (world, nodes) => sensitiveMayMeet(index, world, nodes),
            mayPaint: world => mayPaint(index, world), ...(occupiedRoot ? { occupiedRoot } : {}),
            isCurrent: () => !released && !controller.signal.aborted && !closePromise && source.isCurrent(),
            async next() {
                if (closePromise) throw cancelled();
                signal.throwIfAborted();
                if (next) throw new Error('Scene paint stream is sequential');
                const pending = Promise.resolve().then(() => source.next());
                next = pending;
                try {
                    const node = await pending;
                    if (next === pending) next = undefined;
                    signal.throwIfAborted();
                    if (closePromise) throw cancelled();
                    if (node === null) await close();
                    return node;
                } catch (error) {
                    if (next === pending) next = undefined;
                    try { await close(); } catch (cleanupError) { try { options.onError?.(cleanupError); } catch { /* Preserve the original failure. */ } }
                    throw error;
                }
            },
            release: close,
        };
    };
    const document = (): Promise<BoardDoc> => {
        check();
        if (!building) {
            const input: BoardDocInput = { kind: metadata.kind, sheets: metadata.sheets.values(), nodes: records.values(),
                media: metadata.media.values(), ui: metadata.ui, view: metadata.view, host: metadata.host,
                preserved: metadata.preserved, preservedMediaRefs: metadata.preservedMediaRefs };
            const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
            building = track(createLoadedBoardDoc(input, cooperate, controller.signal).then(doc => {
                check();
                return { ...doc, rev: revision };
            }).catch(error => {
                if (!released) { try { options.onError?.(error); } catch { /* Preserve the original failure. */ } }
                throw error;
            }));
        }
        return building;
    };
    const snapshot: SceneSnapshot = {
        token, revision, isCurrent: () => !released && !controller.signal.aborted,
        get nodeCount() { check(); return nodeCount; },
        get occupiedBounds() { check(); return occupiedBounds; },
        get layout() { return boardPageStack(metadata.host) ?? null; },
        worldBounds(id) {
            if (released || !records.get(id)) return null;
            return options.bounds?.get(id) ?? { revision, quality: BoundsQuality.Pending, ink: null, selectable: null };
        },
        countCandidates(sheetId, world) {
            check();
            const index = ready.get(sheetId);
            return index ? index.countCandidates(world) : null;
        },
        readNodeNow(id) { check(); return records.get(id); },
        metadataNow() { check(); return metadata; },
        async readDocument(signal) {
            check(); signal?.throwIfAborted();
            const doc = await waitFor(document(), signal);
            check(); signal?.throwIfAborted();
            return doc;
        },
        async paintSource(request, signal) {
            check();
            if (signal?.aborted) throw signal.reason ?? cancelled();
            const pinnedRequest = copyRequest(request);
            const work = track((async () => {
                const doc = paintDocument();
                const index = await indexFor(pinnedRequest.sheetId);
                check();
                const source = await options.prepare(doc, pinnedRequest, controller.signal, ordered(index, pinnedRequest));
                check();
                if (!source || source.sceneRevision !== revision || !sameToken(source.token, token)) throw new TypeError('Paint source does not match scene snapshot');
                const extended = source as PaintNodeSource & { readonly sessionRasters?: unknown; readonly rasterVariant?: unknown };
                return { sourceDoc: doc, token, theme: source.theme, sceneRevision: revision, sensitiveNodes: source.sensitiveNodes, nodeCount: source.nodeCount,
                    ...{ sessionRasters: extended.sessionRasters, rasterVariant: extended.rasterVariant, sourceWorld: pinnedRequest.world },
                    readNode: (index: number) => source.readNode(index), isCurrent: () => !released && !controller.signal.aborted } satisfies PaintNodeSource;
            })());
            return waitFor(work, signal);
        },
        ...(options.prepareStream ? { async paintStream(request: ScenePaintRequest, signal?: AbortSignal, resolved?: ResolvedNodeCache) {
            check(); signal?.throwIfAborted();
            const pinnedRequest = copyRequest(request), local = new AbortController();
            const combined = AbortSignal.any(signal ? [controller.signal, local.signal, signal] : [controller.signal, local.signal]);
            const work = track((async () => {
                const doc = paintDocument();
                const index = await indexFor(pinnedRequest.sheetId);
                check(); combined.throwIfAborted();
                const source = options.prepareStream!(doc, pinnedRequest, combined, ordered(index, pinnedRequest), resolved);
                const stream = wrapStream(source, combined, local, pinnedRequest.world, index);
                try {
                    check(); combined.throwIfAborted();
                    if (source.sceneRevision !== revision || !sameToken(source.token, token) || source.sourceDoc !== doc) {
                        throw new TypeError('Paint stream does not match scene snapshot');
                    }
                    return stream;
                } catch (error) {
                    try { await stream.release(); } catch (cleanupError) { try { options.onError?.(cleanupError); } catch { /* Preserve the original failure. */ } }
                    throw error;
                }
            })());
            return work;
        } } : {}),
        release() {
            if (closing) return closing;
            released = true;
            controller.abort(cancelled());
            closing = (async () => {
                await Promise.allSettled([...inFlight]);
                const retired = await Promise.allSettled([...streams].map(close => close()));
                const failure = retired.find(result => result.status === 'rejected');
                indexes.clear(); ready.clear();
                for (const index of built.splice(0)) index.close();
                if (failure?.status === 'rejected') throw failure.reason;
                try { records.release(); } finally { options.renderer?.release(); }
            })();
            return closing;
        },
    };
    return snapshot;
}
