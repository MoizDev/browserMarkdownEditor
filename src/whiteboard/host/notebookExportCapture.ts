import { paperPageSize } from '../../utils/paper';
import type { NotebookExportSnapshot } from './notebookExport';
import { pinPagedBoardScene } from './pagedSceneCapture';
import type { BoardRuntime } from './runtime';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaEntry, MediaId } from '../model/media';
import { createExportImageResolver } from '../export/exportImage';
import { streamPageDisplayList } from '../export/streamPage';
import { writeIncrementalPdfPage, type IncrementalPdfPage } from '../export/incrementalPdf';

export function pinNativeNotebookExport({ runtime, revision, current, onError }: {
    readonly runtime: BoardRuntime; readonly revision: number; readonly current: () => boolean; readonly onError: (error: unknown) => void;
}): { readonly revision: number; readonly snapshot: NotebookExportSnapshot; release(): void } {
    const doc = runtime.session.doc;
    if (!current() || doc.rev !== revision || doc.kind !== 'notebook' || doc.host.kind !== 'notebook') {
        throw new Error('A current notebook revision is required');
    }
    const paper = Object.freeze({ ...doc.host.paper }), pin = pinPagedBoardScene(runtime, revision, current, onError);
    try {
        const { width, height } = paperPageSize(paper);
        if (pin.rects.length !== paper.pageCount || pin.rects.some(rect => rect.width !== width || rect.height !== height)) {
            throw new Error('Notebook page layout differs from its paper');
        }
        return { revision, snapshot: { revision, paper, sheets: pin.sheets, readSheetPage: pin.readSheetPage, writeSheetPage: pin.writeSheetPage }, release: pin.release };
    } catch (error) { pin.release(); throw error; }
}

export function pinNotebookExportWithMedia(options: {
    readonly runtime: BoardRuntime;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly onError: (error: unknown) => void;
}): { readonly revision: number; readonly snapshot: NotebookExportSnapshot; release(): void } {
    const { runtime } = options, doc = runtime.session.doc, spatial = runtime.scene;
    if (!spatial || !spatial.ready || spatial.revision !== doc.rev || doc.host.kind !== 'notebook')
        throw new Error('Notebook export scene is not ready');
    const scene = spatial.pin(), leases: { release(): void }[] = [];
    let released = false, images: ReturnType<typeof createBoardHostImages> | undefined;
    const lifetime = new AbortController();
    const release = () => {
        if (released) return;
        released = true; lifetime.abort();
        try { images?.dispose(); } finally {
            try { for (const lease of leases) lease.release(); } finally { scene.release(); }
        }
    };
    try {
        if (scene.revision !== doc.rev || !scene.layout || scene.token.documentId !== runtime.session.owner.documentId
            || scene.token.session !== runtime.session.owner.session) throw new Error('Notebook export identity changed');
        const paper = Object.freeze({ ...doc.host.paper }), rects = scene.layout.rects.map(rect => ({ ...rect }));
        const size = paperPageSize(paper);
        if (rects.length !== paper.pageCount || rects.some(rect => rect.width !== size.width || rect.height !== size.height))
            throw new Error('Notebook export paper geometry changed');
        const sheets = Object.freeze(doc.sheetOrder.map(sheet => sheet.id));
        const entries = new Map<MediaId, MediaEntry>(), blobs = new Map<MediaId, Promise<Blob>>();
        for (const [id, entry] of doc.media) { entries.set(id, structuredClone(entry)); leases.push(runtime.media.retain(id, 'snapshot')); }
        const read = (id: MediaId, signal: AbortSignal): Promise<Blob> => {
            signal.throwIfAborted();
            const entry = entries.get(id);
            if (released || !entry) return Promise.reject(new Error('Notebook export media is unavailable'));
            let pending = blobs.get(id);
            if (!pending) {
                pending = (async () => {
                    const blob = runtime.media.get(id) ?? await options.readMedia(entry, lifetime.signal);
                    lifetime.signal.throwIfAborted();
                    if (!(blob instanceof Blob) || blob.size !== entry.bytes) throw new Error('Notebook export media bytes are unavailable');
                    return blob.slice(0, blob.size, blob.type);
                })();
                blobs.set(id, pending);
                void pending.catch(() => { if (blobs.get(id) === pending) blobs.delete(id); });
            }
            const shared = pending;
            return new Promise<Blob>((resolve, reject) => {
                const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Notebook export cancelled', 'AbortError')); };
                signal.addEventListener('abort', abort, { once: true });
                shared.then(value => {
                    signal.removeEventListener('abort', abort);
                    if (lifetime.signal.aborted) reject(lifetime.signal.reason); else resolve(value);
                }, error => { signal.removeEventListener('abort', abort); reject(error); });
                if (signal.aborted) abort();
            });
        };
        const token = scene.token;
        images = createBoardHostImages({ token, media: runtime.media, entry: id => entries.get(id), readBlob: read,
            identity: { session: `notebook-export:${crypto.randomUUID()}`, epoch: token.vaultEpoch, revision: scene.revision },
            current: candidate => !released && candidate.documentId === token.documentId && candidate.session === token.session
                && candidate.vaultEpoch === token.vaultEpoch && candidate.bytesGeneration === token.bytesGeneration,
            onError: options.onError });
        const provider = images;
        const capturePage = async (sheet: typeof sheets[number], page: number, signal: AbortSignal) => {
            const active = AbortSignal.any([signal, lifetime.signal]);
            active.throwIfAborted();
            const world = rects[page];
            if (released || !world || !sheets.includes(sheet)) throw new RangeError('Invalid notebook export page');
            const source = await scene.paintSource({ sheetId: sheet, page, world, theme: 'light' }, active);
            active.throwIfAborted();
            const image = createExportImageResolver(token, provider, (key, imageSignal) => {
                const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
                if (!match) throw new TypeError('Invalid notebook export image key');
                return read(`sha256:${match[1] ?? match[2]}`, imageSignal);
            }, active);
            return { source, world, image, active };
        };
        return { revision: scene.revision, release, snapshot: { revision: scene.revision, paper, sheets,
            async writeSheetPage(sheet, page, sink: IncrementalPdfPage, signal) {
                const captured = await capturePage(sheet, page, signal);
                await writeIncrementalPdfPage(captured, page, 1, captured.image, sink, captured.active);
                captured.active.throwIfAborted();
            },
            async readSheetPage(sheet, page, signal) {
                const combined = AbortSignal.any([signal, lifetime.signal]);
                combined.throwIfAborted();
                const world = rects[page];
                if (!world || !sheets.includes(sheet)) throw new RangeError('Invalid notebook export page');
                const source = await scene.paintSource({ sheetId: sheet, page, world, theme: 'light' }, combined);
                const image = createExportImageResolver(token, provider, (key, imageSignal) => {
                    const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
                    if (!match) throw new TypeError('Invalid notebook export image key');
                    return read(`sha256:${match[1] ?? match[2]}`, imageSignal);
                }, combined);
                return streamPageDisplayList(source, page, world, 1, image, combined);
            } } };
    } catch (error) { release(); throw error; }
}


