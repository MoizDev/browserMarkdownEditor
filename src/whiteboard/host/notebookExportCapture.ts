import { paperPageSize } from '../../utils/paper';
import { exportNotebookPdf, type NotebookExportSnapshot } from './notebookExport';
import type { DisplayPdfWriter } from '../export/capturePdf';
import type { BuildJob } from '../session/BoardSession';
import { pinPagedBoardScene } from './pagedSceneCapture';
import type { BoardRuntime } from './runtime';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaEntry, MediaId } from '../model/media';
import { createExportImageResolver } from '../export/exportImage';
import { streamPageDisplayList } from '../export/streamPage';

/** Pins the notebook's real paper and scene at one revision; the caller owns its release. */
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
        return { revision, snapshot: { paper, sheets: pin.sheets, readSheetPage: pin.readSheetPage }, release: pin.release };
    } catch (error) { pin.release(); throw error; }
}

/** App's captured media reader is session-owned, not a pane image reader. */
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
            return pending.then(value => { signal.throwIfAborted(); lifetime.signal.throwIfAborted(); return value; });
        };
        const token = scene.token;
        images = createBoardHostImages({ token, media: runtime.media, entry: id => entries.get(id), readBlob: read,
            identity: { session: `notebook-export:${crypto.randomUUID()}`, epoch: token.vaultEpoch, revision: scene.revision },
            current: candidate => !released && candidate.documentId === token.documentId && candidate.session === token.session
                && candidate.vaultEpoch === token.vaultEpoch && candidate.bytesGeneration === token.bytesGeneration,
            onError: options.onError });
        const provider = images;
        return { revision: scene.revision, release, snapshot: { paper, sheets,
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

/** The BuildJob acquires its revision before it is returned, not when run starts. */
export function createNotebookExportJob(options: {
    readonly runtime: BoardRuntime;
    readonly sourcePath: string;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly writer: DisplayPdfWriter;
    readonly onError: (error: unknown) => void;
}): BuildJob & { release(): void } {
    const pinned = pinNotebookExportWithMedia(options);
    let released = false, started = false;
    const release = () => { if (!released) { released = true; pinned.release(); } };
    return { kind: 'build', revision: pinned.revision, release,
        async run(signal) {
            if (released || started) throw new Error('Notebook export job is no longer available');
            started = true;
            try { return await exportNotebookPdf(pinned.snapshot, options.sourcePath, options.writer, signal); }
            finally { release(); }
        } };
}
