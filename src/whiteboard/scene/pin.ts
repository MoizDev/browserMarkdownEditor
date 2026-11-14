import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc, BoardDocInput } from '../model/doc';
import type { NodeId } from '../model/ids';
import { createLoadedBoardDoc } from '../model/loadDocument';
import { boardPageStack } from '../model/pages';
import type { PaintNodeSource } from '../render/paintStream';
import type { PaintNodeOrder } from '../render/paintOrder';
import { BoundsQuality, validBox } from './bounds';
import { createPinnedPaintDoc } from './paintDoc';
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
    renderer?: { release(): void };
    prepare: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal, orderedIds?: PaintNodeOrder) => Promise<PaintNodeSource>;
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
    const check = () => { if (released || controller.signal.aborted) throw cancelled(); };
    const track = <T,>(promise: Promise<T>): Promise<T> => {
        inFlight.add(promise);
        void promise.then(() => { inFlight.delete(promise); }, () => { inFlight.delete(promise); });
        return promise;
    };
    const paintDocument = (): BoardDoc => { check(); return paintDoc ??= createPinnedPaintDoc(records, metadata, revision, check); };
    const ordered = function* (request: ScenePaintRequest): Generator<NodeId | null> {
        check();
        let visited = 0, started = performance.now();
        const world = request.world;
        const cull = world && [world.x, world.y, world.width, world.height, world.x + world.width, world.y + world.height]
            .every(Number.isFinite) && world.width >= 0 && world.height >= 0 ? world : undefined;
        const stack: Iterator<import('../model/nodes').Node>[] = [records.children(request.sheetId)[Symbol.iterator]()];
        while (stack.length) {
            check();
            if (++visited >= 64 || performance.now() - started >= 0.25) {
                yield null; check(); visited = 0; started = performance.now();
            }
            const next = stack[stack.length - 1].next();
            if (next.done) { stack.pop(); continue; }
            const node = next.value, bounds = cull ? options.bounds?.get(node.id) : undefined;
            const usable = bounds?.revision === revision && (bounds.quality === BoundsQuality.Exact || bounds.quality === BoundsQuality.Conservative)
                && bounds.ink;
            if (!cull || !usable || !(usable[2] < cull.x || usable[0] > cull.x + cull.width
                || usable[3] < cull.y || usable[1] > cull.y + cull.height)) yield node.id;
            if (records.childCount(node.id)) {
                if (stack.length >= 65) throw new RangeError('Invalid scene parent depth');
                stack.push(records.children(node.id)[Symbol.iterator]());
            }
        }
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
        token, revision,
        get nodeCount() { check(); return nodeCount; },
        get occupiedBounds() { check(); return occupiedBounds; },
        get layout() { return boardPageStack(metadata.host) ?? null; },
        worldBounds(id) {
            if (released || !records.get(id)) return null;
            return options.bounds?.get(id) ?? { revision, quality: BoundsQuality.Pending, ink: null, selectable: null };
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
            const pinnedRequest = { ...request, ...(request.world ? { world: { ...request.world } } : {}),
                ...(request.sensitiveNodes ? { sensitiveNodes: new Set(request.sensitiveNodes) } : {}) };
            const work = track((async () => {
                const doc = paintDocument();
                check();
                const source = await options.prepare(doc, pinnedRequest, controller.signal, ordered(pinnedRequest));
                check();
                if (!source || source.sceneRevision !== revision || !sameToken(source.token, token)) throw new TypeError('Paint source does not match scene snapshot');
                return { sourceDoc: doc, token, sceneRevision: revision, sensitiveNodes: source.sensitiveNodes, nodeCount: source.nodeCount,
                    readNode: (index: number) => source.readNode(index), isCurrent: () => !released && !controller.signal.aborted } satisfies PaintNodeSource;
            })());
            return waitFor(work, signal);
        },
        release() {
            if (closing) return closing;
            released = true;
            controller.abort(cancelled());
            closing = (async () => {
                await Promise.allSettled([...inFlight]);
                try { records.release(); } finally { options.renderer?.release(); }
            })();
            return closing;
        },
    };
    return snapshot;
}
