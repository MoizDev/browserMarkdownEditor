import { createExportImageResolver } from '../export/exportImage';
import { streamPageDisplayList } from '../export/streamPage';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaLease } from '../media/store';
import type { SheetId } from '../model/ids';
import type { MediaId } from '../model/media';
import type { BoardRuntime } from './runtime';
import { inspectPdfVisualDoc, type PdfVisualPreflight } from './pdfVisualPreflight';

/** Pin the actual paged scene and embedded/media-store bytes, not live view geometry. */
export function pinPagedBoardScene(runtime: BoardRuntime, revision: number, current: () => boolean, onError: (error: unknown) => void) {
    const doc = runtime.session.doc;
    if (!current() || doc.rev !== revision || !runtime.scene) throw new Error('Paged board scene is not ready for this revision');
    const scene = runtime.scene.pin(), held: MediaLease[] = [], lifetime = new AbortController();
    let images: ReturnType<typeof createBoardHostImages> | undefined, released = false;
    let assessment: Promise<PdfVisualPreflight> | undefined;
    const visualCheck = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (!assessment) {
            assessment = scene.readDocument(lifetime.signal).then(doc => inspectPdfVisualDoc(doc, { signal: lifetime.signal }))
                .catch(error => { assessment = undefined; throw error; });
        }
        const result = await new Promise<PdfVisualPreflight>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
            assessment!.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
                error => { signal.removeEventListener('abort', abort); reject(error); });
            if (signal.aborted) abort();
        });
        if (result.status !== 'known') throw new Error('Board content cannot be safely represented in a PDF');
    };
    const release = () => {
        if (released) return;
        released = true;
        lifetime.abort();
        try { images?.dispose(); } finally {
            try { scene.release(); } finally { for (const lease of held) lease.release(); }
        }
    };
    try {
        if (scene.revision !== revision || !scene.layout) throw new Error('Paged scene revision or layout is unavailable');
        const rects = Object.freeze(scene.layout.rects.map(rect => Object.freeze({ ...rect })));
        const sheets = Object.freeze(doc.sheetOrder.map(sheet => sheet.id));
        const entries = new Map([...doc.media].map(([id, entry]) => [id, structuredClone(entry)]));
        const blobs = new Map<MediaId, Blob>();
        for (const [id, entry] of entries) {
            held.push(runtime.media.retain(id, 'snapshot'));
            const blob = runtime.media.get(id);
            if (!blob || blob.size !== entry.bytes) throw new Error(`Captured board media is unavailable: ${id}`);
            blobs.set(id, blob);
        }
        for (const [id, refs] of doc.mediaRefs) if (refs.size && !entries.has(id)) throw new Error(`Board media has no metadata: ${id}`);
        for (const [id, count] of doc.preservedMediaRefs) if (count > 0 && !entries.has(id)) throw new Error(`Preserved media has no metadata: ${id}`);
        const token = scene.token;
        const readBlob = (id: MediaId, signal: AbortSignal): Promise<Blob> => {
            signal.throwIfAborted();
            const blob = blobs.get(id);
            if (released || !current() || !blob) return Promise.reject(new Error(`Captured board media is unavailable: ${id}`));
            return Promise.resolve(blob);
        };
        images = createBoardHostImages({ token, media: runtime.media, entry: id => entries.get(id), readBlob,
            identity: { session: `${token.documentId}:${token.session}`, epoch: token.vaultEpoch, revision },
            current: candidate => !released && current() && candidate.documentId === token.documentId && candidate.session === token.session &&
                candidate.vaultEpoch === token.vaultEpoch && candidate.bytesGeneration === token.bytesGeneration, onError });
        const capturedImages = images;
        const readImage = (key: string, signal: AbortSignal) => {
            const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
            if (!match) throw new TypeError('Invalid captured board image key');
            return readBlob(`sha256:${match[1] ?? match[2]}` as MediaId, signal);
        };
        return {
            revision, rects, sheets, media: Object.freeze([...entries.values()]),
            mediaBlob: (id: MediaId) => blobs.get(id),
            async readSheetPage(sheet: SheetId, page: number, signal: AbortSignal) {
                signal.throwIfAborted();
                const box = rects[page];
                if (released || !current() || !box || !sheets.includes(sheet)) throw new Error('Captured board page is unavailable');
                await visualCheck(signal);
                signal.throwIfAborted();
                if (released || !current()) throw new DOMException('Board capture ended', 'AbortError');
                const source = await scene.paintSource({ sheetId: sheet, page, world: box, theme: 'light' }, signal);
                signal.throwIfAborted();
                if (released || !current()) throw new DOMException('Board capture ended', 'AbortError');
                const list = await streamPageDisplayList(source, page, box, 1, createExportImageResolver(token, capturedImages, readImage, signal), signal);
                if (released || !current()) throw new DOMException('Board capture ended', 'AbortError');
                return list;
            },
            release,
        };
    } catch (error) { release(); throw error; }
}
