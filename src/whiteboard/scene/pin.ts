import type { RenderToken } from '../../platform/render/types';
import type { BoardDoc, BoardDocInput } from '../model/doc';
import type { NodeId } from '../model/ids';
import { createLoadedBoardDoc } from '../model/loadDocument';
import { boardPageStack } from '../model/pages';
import type { PaintNodeSource } from '../render/paintStream';
import { BoundsQuality } from './bounds';
import type { SceneRecordPin } from './recordStore';
import type { SceneMetadata } from './snapshotDoc';
import type { SceneBounds, ScenePaintRequest, SceneSnapshot } from './types';

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
    prepare: (doc: BoardDoc, request: ScenePaintRequest, signal: AbortSignal) => Promise<PaintNodeSource>;
    cooperate?: () => Promise<void>;
    onError?: (error: unknown) => void;
}): SceneSnapshot {
    const token: RenderToken = Object.freeze({ ...options.token }), revision = options.revision;
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(token.vaultEpoch) || token.vaultEpoch < 0
        || !Number.isSafeInteger(token.bytesGeneration) || token.bytesGeneration < 0 || !Number.isSafeInteger(token.session) || token.session < 0
        || typeof token.documentId !== 'string' || !token.documentId) throw new TypeError('Invalid scene snapshot identity');
    const controller = new AbortController(), { records, metadata } = options;
    let released = false, building: Promise<BoardDoc> | undefined;
    const check = () => { if (released || controller.signal.aborted) throw cancelled(); };
    const document = (): Promise<BoardDoc> => {
        check();
        if (!building) {
            const input: BoardDocInput = { kind: metadata.kind, sheets: metadata.sheets.values(), nodes: records.values(),
                media: metadata.media.values(), ui: metadata.ui, view: metadata.view, host: metadata.host,
                preserved: metadata.preserved, preservedMediaRefs: metadata.preservedMediaRefs };
            const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
            building = createLoadedBoardDoc(input, cooperate, controller.signal).then(doc => {
                check();
                return { ...doc, rev: revision };
            }).catch(error => {
                if (!released) { try { options.onError?.(error); } catch { /* Preserve the original failure. */ } }
                throw error;
            });
        }
        return building;
    };
    const snapshot: SceneSnapshot = {
        token, revision,
        get layout() { return boardPageStack(metadata.host) ?? null; },
        worldBounds(id) {
            if (released || !records.get(id)) return null;
            return options.bounds?.get(id) ?? { revision, quality: BoundsQuality.Pending, ink: null, selectable: null };
        },
        async paintSource(request, signal) {
            check();
            if (signal?.aborted) throw signal.reason ?? cancelled();
            const pinnedRequest = { ...request, ...(request.world ? { world: { ...request.world } } : {}) };
            const work = (async () => {
                const doc = await document();
                check();
                const source = await options.prepare(doc, pinnedRequest, controller.signal);
                check();
                if (!source || source.sceneRevision !== revision || !sameToken(source.token, token)) throw new TypeError('Paint source does not match scene snapshot');
                return { token, sceneRevision: revision, nodeCount: source.nodeCount,
                    readNode: (index: number) => source.readNode(index), isCurrent: () => !released && !controller.signal.aborted } satisfies PaintNodeSource;
            })();
            return waitFor(work, signal);
        },
        release() {
            if (released) return;
            released = true;
            controller.abort(cancelled());
            records.release();
        },
    };
    return snapshot;
}
