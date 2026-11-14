import type { BoardRuntime } from '../host/runtime';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaEntry, MediaId } from '../model/media';
import type { ScenePaintRequest } from '../scene/types';
import type { PinExportSnapshot } from './snapshot';

export interface BoardExportSnapshotOptions {
    readonly runtime: BoardRuntime;
    readonly request: ScenePaintRequest;
    readonly selectedNodeIds?: readonly string[];
    /** App supplies a reader whose authority survives the originating pane. */
    readMedia(entry: Readonly<MediaEntry>, signal: AbortSignal): Promise<Blob>;
    onError(error: unknown): void;
}

function mediaId(key: string): MediaId {
    const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
    if (!match) throw new TypeError('Invalid export image key');
    return `sha256:${match[1] ?? match[2]}`;
}

/** Factory for snapshotExport: pin the canonical scene and media before any asynchronous work. */
export function createBoardExportSnapshot(options: BoardExportSnapshotOptions): PinExportSnapshot {
    const request = { ...options.request, world: options.request.world && { ...options.request.world } };
    const selected = options.selectedNodeIds && new Set(options.selectedNodeIds);
    return () => {
        const { runtime } = options;
        const scene = runtime.scene, doc = runtime.session.doc;
        if (!scene || !scene.ready || scene.revision !== doc.rev || !doc.sheets.has(request.sheetId))
            throw new Error('Board export scene is not ready');
        const pin = scene.pin();
        const leases: { release(): void }[] = [];
        let images: ReturnType<typeof createBoardHostImages> | undefined;
        let released = false;
        try {
            if (pin.revision !== doc.rev || pin.token.documentId !== runtime.session.owner.documentId
                || pin.token.session !== runtime.session.owner.session) throw new Error('Board export identity changed');
            const entries = new Map<MediaId, MediaEntry>();
            for (const [id, entry] of doc.media) {
                entries.set(id, structuredClone(entry));
                leases.push(runtime.media.retain(id, 'snapshot'));
            }
            const blobs = new Map<MediaId, Promise<Blob>>();
            const read = (id: MediaId, signal: AbortSignal): Promise<Blob> => {
                signal.throwIfAborted();
                if (released) return Promise.reject(new DOMException('Export released', 'AbortError'));
                const entry = entries.get(id);
                if (!entry) return Promise.reject(new Error('Export media is unavailable'));
                let pending = blobs.get(id);
                if (!pending) {
                    pending = (async () => {
                        const stored = runtime.media.get(id);
                        const source = stored ?? await options.readMedia(entry, signal);
                        signal.throwIfAborted();
                        if (!(source instanceof Blob) || source.size !== entry.bytes) throw new Error('Export media bytes are unavailable');
                        return source.slice(0, source.size, source.type);
                    })();
                    blobs.set(id, pending);
                    void pending.catch(() => { if (blobs.get(id) === pending) blobs.delete(id); });
                }
                return pending.then(blob => { signal.throwIfAborted(); if (released) throw new DOMException('Export released', 'AbortError'); return blob; });
            };
            const token = Object.freeze({ ...pin.token });
            images = createBoardHostImages({ token, media: runtime.media,
                identity: { session: `export:${crypto.randomUUID()}`, epoch: token.vaultEpoch, revision: pin.revision },
                entry: id => entries.get(id), readBlob: read,
                current: candidate => !released && candidate.vaultEpoch === token.vaultEpoch && candidate.documentId === token.documentId
                    && candidate.bytesGeneration === token.bytesGeneration && candidate.session === token.session,
                onError: options.onError });
            const provider = images;
            return {
                token, revision: pin.revision, images: provider,
                readImage: (key, signal) => read(mediaId(key), signal),
                async paintSource(signal) {
                    signal.throwIfAborted();
                    const source = await pin.paintSource(request, signal);
                    signal.throwIfAborted();
                    if (!selected) return source;
                    return { token: source.token, sceneRevision: source.sceneRevision, nodeCount: source.nodeCount,
                        isCurrent: () => !released && source.isCurrent(),
                        readNode(index) {
                            const node = source.readNode(index);
                            return { underlay: node.underlay?.filter(item => selected.has(item.nodeId)),
                                content: node.content.filter(item => selected.has(item.nodeId)) };
                        } };
                },
                release() {
                    if (released) return;
                    released = true;
                    try { provider.dispose(); } finally {
                        try { for (const lease of leases) lease.release(); } finally { pin.release(); }
                    }
                },
            };
        } catch (error) {
            try { images?.dispose(); } finally {
                try { for (const lease of leases) lease.release(); } finally { pin.release(); }
            }
            throw error;
        }
    };
}
