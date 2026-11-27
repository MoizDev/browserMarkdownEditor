import type { BoardRuntime } from '../host/runtime';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaEntry, MediaId } from '../model/media';
import type { ScenePaintRequest } from '../scene/types';
import type { SheetId } from '../model/ids';
import type { PaintNodeSource } from '../render/paintStream';
import { notebookBackdrop } from '../host/notebookBackdrop';
import type { PinExportSnapshot } from './snapshot';
import { yieldToHost } from '../../platform/yieldToHost';

export interface BoardExportSnapshotOptions {
    readonly runtime: BoardRuntime;
    readonly request: ScenePaintRequest;
    readonly selectedNodeIds?: readonly string[];
    readonly sheetIds?: readonly SheetId[];
    readonly includeNotebookPaper?: boolean;
    readMedia(entry: Readonly<MediaEntry>, signal: AbortSignal): Promise<Blob>;
    onError(error: unknown): void;
}

function mediaId(key: string): MediaId {
    const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
    if (!match) throw new TypeError('Invalid export image key');
    return `sha256:${match[1] ?? match[2]}`;
}

export function createBoardExportSnapshot(options: BoardExportSnapshotOptions): PinExportSnapshot {
    const request = { ...options.request, world: options.request.world && { ...options.request.world } };
    const requestedSelection = options.selectedNodeIds && [...options.selectedNodeIds];
    const requestedSheets = options.sheetIds && [...options.sheetIds];
    return () => {
        const { runtime } = options;
        const scene = runtime.scene, doc = runtime.session.doc;
        if (!scene || !scene.ready || scene.revision !== doc.rev || !doc.sheets.has(request.sheetId))
            throw new Error('Board export scene is not ready');
        const pin = scene.pin();
        const selected = requestedSelection && new Set(requestedSelection);
        let selectionWork: Promise<void> | undefined;
        const leases: { release(): void }[] = [];
        let images: ReturnType<typeof createBoardHostImages> | undefined;
        let released = false;
        const lifetime = new AbortController();
        try {
            if (pin.revision !== doc.rev || pin.token.documentId !== runtime.session.owner.documentId
                || pin.token.session !== runtime.session.owner.session) throw new Error('Board export identity changed');
            const sheets = requestedSheets ?? (options.includeNotebookPaper ? doc.sheetOrder.map(sheet => sheet.id) : [request.sheetId]);
            if (!sheets.length || new Set(sheets).size !== sheets.length || sheets.some(sheet => !doc.sheets.has(sheet)))
                throw new Error('Invalid board export sheets');
            const paper = options.includeNotebookPaper && doc.host.kind === 'notebook' ? { ...doc.host.paper } : null;
            if (options.includeNotebookPaper && !paper) throw new Error('Notebook export paper is unavailable');
            if (paper && selected) throw new Error('Selection exports cannot include notebook paper');
            const paperPages = paper && pin.layout ? pin.layout.rects.map((rect, page) => ({ rect: { ...rect }, page })).filter(({ rect, page }) => {
                if (request.page !== undefined && request.page !== page) return false;
                const world = request.world;
                return !world || rect.x < world.x + world.width && rect.x + rect.width > world.x
                    && rect.y < world.y + world.height && rect.y + rect.height > world.y;
            }) : [];
            if (paper && (!pin.layout || pin.layout.rects.length !== paper.pageCount)) throw new Error('Notebook export page geometry is unavailable');
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
                        const source = stored ?? await options.readMedia(entry, lifetime.signal);
                        lifetime.signal.throwIfAborted();
                        if (!(source instanceof Blob) || source.size !== entry.bytes) throw new Error('Export media bytes are unavailable');
                        return source.slice(0, source.size, source.type);
                    })();
                    blobs.set(id, pending);
                    void pending.catch(() => { if (blobs.get(id) === pending) blobs.delete(id); });
                }
                const shared = pending;
                return new Promise<Blob>((resolve, reject) => {
                    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Export cancelled', 'AbortError')); };
                    signal.addEventListener('abort', abort, { once: true });
                    shared.then(blob => {
                        signal.removeEventListener('abort', abort);
                        if (released) reject(new DOMException('Export released', 'AbortError')); else resolve(blob);
                    }, error => { signal.removeEventListener('abort', abort); reject(error); });
                    if (signal.aborted) abort();
                });
            };
            const token = Object.freeze({ ...pin.token });
            images = createBoardHostImages({ token, media: runtime.media,
                identity: { session: `export:${crypto.randomUUID()}`, epoch: token.vaultEpoch, revision: pin.revision },
                entry: id => entries.get(id), readBlob: read,
                current: candidate => !released && candidate.vaultEpoch === token.vaultEpoch && candidate.documentId === token.documentId
                    && candidate.bytesGeneration === token.bytesGeneration && candidate.session === token.session,
                onError: options.onError });
            const provider = images;
            const expandSelection = (signal: AbortSignal): Promise<void> => {
                if (!selected) return Promise.resolve();
                if (!selectionWork) selectionWork = (async () => {
                    const captured = await pin.readDocument(signal), stack = [...selected];
                    let visits = 0;
                    while (stack.length) {
                        signal.throwIfAborted();
                        const id = stack.pop()!;
                        if (!captured.nodes.has(id as import('../model/ids').NodeId)) throw new Error('Selected export node is unavailable');
                        for (const child of captured.children.get(id as import('../model/ids').NodeId) ?? []) {
                            if (!selected.has(child.id)) { selected.add(child.id); stack.push(child.id); }
                            if (++visits % 256 === 0) { await yieldToHost(); signal.throwIfAborted(); }
                        }
                        if (++visits % 256 === 0) await yieldToHost();
                    }
                })().catch(error => { selectionWork = undefined; throw error; });
                return selectionWork;
            };
            return {
                token, revision: pin.revision, images: provider,
                readImage: (key, signal) => read(mediaId(key), signal),
                async paintSource(signal) { return this.paintSourceFor!(request.world, request.page, signal); },
                async paintSourceFor(world, page, signal) {
                    signal.throwIfAborted();
                    await expandSelection(signal);
                    signal.throwIfAborted();
                    const pages = paperPages.filter(entry => {
                        if (page !== undefined && page !== entry.page) return false;
                        const rect = entry.rect;
                        return !world || rect.x < world.x + world.width && rect.x + rect.width > world.x
                            && rect.y < world.y + world.height && rect.y + rect.height > world.y;
                    });
                    const sources: PaintNodeSource[] = [];
                    for (const sheetId of sheets) {
                        const source = await pin.paintSource({ ...request, sheetId, world, page, theme: paper ? 'light' : request.theme }, signal);
                        signal.throwIfAborted();
                        const candidate = source.token;
                        if (source.sceneRevision !== pin.revision || candidate.documentId !== token.documentId || candidate.session !== token.session
                            || candidate.vaultEpoch !== token.vaultEpoch || candidate.bytesGeneration !== token.bytesGeneration || !source.isCurrent())
                            throw new Error('Export sheet identity changed');
                        sources.push(source);
                    }
                    const ends: number[] = [];
                    let count = pages.length;
                    for (const source of sources) { count += source.nodeCount * 2; ends.push(count); }
                    if (!Number.isSafeInteger(count)) throw new RangeError('Export paint count exceeds limits');
                    return { token, sceneRevision: pin.revision, nodeCount: count,
                        isCurrent: () => !released && sources.every(source => source.isCurrent()),
                        readNode(index) {
                            if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError('Invalid export paint index');
                            if (index < pages.length) {
                                const page = pages[index];
                                return { underlay: [...notebookBackdrop(paper!, page.page, page.rect)], content: [] };
                            }
                            let sourceIndex = 0;
                            while (index >= ends[sourceIndex]) sourceIndex++;
                            const start = sourceIndex === 0 ? pages.length : ends[sourceIndex - 1];
                            const source = sources[sourceIndex], relative = index - start;
                            const node = source.readNode(relative % source.nodeCount);
                            const items = relative < source.nodeCount ? node.underlay ?? [] : node.content;
                            return { content: selected ? items.filter(item => selected.has(item.nodeId)) : items };
                        } };
                },
                release() {
                    if (released) return;
                    released = true; lifetime.abort();
                    try { provider.dispose(); } finally {
                        try { for (const lease of leases) lease.release(); } finally { pin.release(); }
                    }
                },
            };
        } catch (error) {
            lifetime.abort();
            try { images?.dispose(); } finally {
                try { for (const lease of leases) lease.release(); } finally { pin.release(); }
            }
            throw error;
        }
    };
}
