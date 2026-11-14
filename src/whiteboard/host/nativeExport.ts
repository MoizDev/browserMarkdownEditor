import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import { createPlatformCapturer } from '../../platform/render/captureRuntime';
import type { CaptureRequest, CaptureSnapshot } from '../../platform/render/capture';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { Rect } from '../../platform/types';
import { createExportImageResolver } from '../export/exportImage';
import { createBoardCaptureSnapshot } from '../export/runtimeSnapshot';
import { exportFileName, resolveExportScope, type ExportRoute } from '../export/scope';
import { streamRasterPng } from '../export/streamRaster';
import { streamSvg } from '../export/streamSvg';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaLease } from '../media/store';
import type { MediaId } from '../model/media';
import type { NodeId } from '../model/ids';
import { colourCss } from '../render/colour';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import type { PaintImageProvider } from '../render/resources';
import type { PaintImageItem, PaintNodeSource } from '../render/paintStream';
import { measureBoardPaintBounds } from '../render/worldBounds';
import { notebookBackdrop } from './notebookBackdrop';
import { inspectPdfVisualDoc } from './pdfVisualPreflight';
import type { PdfInkSourceLease } from './pdfInkSourceOwner';
import type { BoardRuntime } from './runtime';

export interface NativeExportOptions {
    readonly runtime: BoardRuntime;
    readonly route: Extract<ExportRoute, 'copy' | 'context' | 'menu'>;
    readonly boardName: string;
    readonly theme: 'light' | 'dark';
    readonly transparent: boolean;
    readonly signal: AbortSignal;
    current(): boolean;
    onError(error: unknown): void;
    /** Only the document-owned PDF source facade can supply this lease. */
    retainPdfSource?(): PdfInkSourceLease;
}

export interface NativeExportJob {
    png(signal: AbortSignal): Promise<Blob>;
    svg(signal: AbortSignal): Promise<Blob>;
    filename(extension: 'png' | 'svg'): string;
    release(): void;
}

let serial = 0;
const stale = () => new DOMException('Board export ended', 'AbortError');

/** Scene, selection and media are pinned before the first asynchronous boundary. */
export async function prepareNativeExport(options: NativeExportOptions): Promise<NativeExportJob> {
    const { runtime, signal, route, theme, transparent, boardName } = options;
    const timestamp = new Date(), doc = runtime.session.doc, scene = runtime.scene;
    signal.throwIfAborted();
    if (!options.current() || !scene?.ready || scene.revision !== doc.rev) throw new Error('Board export scene is not ready');
    const selection = runtime.selection.getSnapshot(), revision = doc.rev, fontEpoch = runtime.render.text.fonts.epoch;
    const selectedRoots = route === 'menu' ? [] : [...selection.selected];
    const selected = new Set<NodeId>(), pending = [...selectedRoots];
    const sheetNodes = doc.bySheet.get(selection.sheet);
    while (pending.length) {
        const id = pending.pop()!;
        if (selected.has(id)) continue;
        const node = doc.nodes.get(id);
        if (!node || !sheetNodes?.has(id)) throw new Error('Export selection no longer belongs to this sheet');
        selected.add(id);
        for (const child of doc.children.get(id) ?? []) pending.push(child.id);
    }
    const selectionOnly = selectedRoots.length > 0;
    const pin = scene.pin(), leases: MediaLease[] = [], lifetime = new AbortController();
    let pdfLease: PdfInkSourceLease | undefined, images: ReturnType<typeof createBoardHostImages> | undefined;
    let pdfBackdrop: Awaited<ReturnType<PdfInkSourceLease['source']['createBackdrop']>> | undefined;
    let released = false, cleaned = false, active = 0;
    const cleanup = () => {
        if (cleaned || active) return;
        cleaned = true;
        signal.removeEventListener('abort', release);
        try { pdfBackdrop?.dispose(); } finally {
            try { images?.dispose(); } finally {
                try { pin.release(); } finally {
                    try { for (const lease of leases) lease.release(); } finally { pdfLease?.release(); }
                }
            }
        }
    };
    const release = () => { if (!released) { released = true; lifetime.abort(); cleanup(); } };
    try {
        if (pin.revision !== revision || pin.token.documentId !== runtime.session.owner.documentId ||
            pin.token.session !== runtime.session.owner.session) throw new Error('Export pin does not match its document');
        const meta = pin.metadataNow(), sheet = meta.sheets.get(selection.sheet);
        if (!sheet) throw new Error('Export sheet is unavailable');
        if (doc.kind === 'pdf-ink' && !selectionOnly) {
            if (!options.retainPdfSource) throw new Error('PDF page export requires the document-owned PDF source');
            pdfLease = options.retainPdfSource();
            const sourceToken = pdfLease.source.source.token;
            if (sourceToken.documentId !== pin.token.documentId || sourceToken.session !== pin.token.session ||
                sourceToken.vaultEpoch !== pin.token.vaultEpoch) throw new Error('PDF backdrop belongs to another document');
        }
        const entries = new Map([...meta.media].map(([id, entry]) => [id, structuredClone(entry)]));
        const blobs = new Map<MediaId, Blob>();
        for (const [id, entry] of entries) {
            leases.push(runtime.media.retain(id, 'snapshot'));
            const blob = runtime.media.get(id);
            if (!blob || blob.size !== entry.bytes) throw new Error(`Captured board media is unavailable: ${id}`);
            blobs.set(id, blob.slice(0, blob.size, blob.type));
        }
        const token = pin.token;
        const readBlob = async (id: MediaId, readSignal: AbortSignal) => {
            readSignal.throwIfAborted();
            const blob = blobs.get(id);
            if (released || !blob) throw new Error(`Captured board media is unavailable: ${id}`);
            return blob;
        };
        images = createBoardHostImages({ token, media: runtime.media, entry: id => entries.get(id), readBlob,
            identity: { session: `export:${crypto.randomUUID()}`, epoch: token.vaultEpoch, revision },
            current: candidate => !released && candidate.documentId === token.documentId && candidate.session === token.session &&
                candidate.vaultEpoch === token.vaultEpoch && candidate.bytesGeneration === token.bytesGeneration, onError: options.onError });
        const capturedImages = images;
        const readImage = (key: string, readSignal: AbortSignal) => {
            const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
            if (!match) throw new TypeError('Invalid captured board image key');
            return readBlob(`sha256:${match[1] ?? match[2]}` as MediaId, readSignal);
        };
        const operationSignal = AbortSignal.any([signal, lifetime.signal]);
        if (pdfLease) {
            pdfBackdrop = await pdfLease.source.createBackdrop({ readOnly: true, isVisible: () => false, isFocused: () => false,
                emphasisEnabled: () => false, onError: options.onError, signal: operationSignal });
            operationSignal.throwIfAborted();
        }
        const frozenDoc = await pin.readDocument(operationSignal);
        operationSignal.throwIfAborted();
        const visual = await inspectPdfVisualDoc(frozenDoc, { signal: operationSignal });
        if (visual.status !== 'known') throw new Error('The export contains unsupported visual content.');
        if (runtime.render.text.fonts.epoch !== fontEpoch) throw new Error('Board fonts changed while preparing the export; retry.');
        const raw = await pin.paintSource({ sheetId: selection.sheet, theme: meta.kind === 'whiteboard' ? theme : 'light', deviceScale: 2 }, operationSignal);
        operationSignal.throwIfAborted();
        if (runtime.render.text.fonts.epoch !== fontEpoch) throw new Error('Board fonts changed while preparing the export; retry.');
        const filtered: PaintNodeSource = selectionOnly ? {
            token: raw.token, sceneRevision: raw.sceneRevision, nodeCount: raw.nodeCount, isCurrent: () => raw.isCurrent(),
            readNode(index) {
                const node = raw.readNode(index);
                return { underlay: node.underlay?.filter(item => selected.has(item.nodeId as NodeId)),
                    content: node.content.filter(item => selected.has(item.nodeId as NodeId)) };
            },
        } : raw;
        const now = performance.now();
        let live = 0;
        const cache = getPlatformRuntime().governor.register({ id: `board-export-bounds:${token.documentId}:${++serial}`,
            owner: token, pool: 'cpu', kind: 'capture', class: 'critical', hiddenAt: null,
            lastVisibleAt: now, lastUsedAt: now, memory: () => ({ live, retiring: 0 }), evict: () => {} });
        let inkBounds: Rect | null;
        try {
            const measured = await measureBoardPaintBounds(filtered, { signal: operationSignal, memory: {
                reserve(bytes) { const lease = cache.reserve(bytes); if (lease) live += lease.bytes; return lease; },
                release(lease) { cache.release(lease); live -= lease.bytes; },
            } });
            const b = measured.bounds;
            inkBounds = b ? { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] } : null;
        } finally { cache.close(); }
        operationSignal.throwIfAborted();
        const pages = pin.layout?.rects;
        if (pdfBackdrop && (!pages || pages.length !== pdfBackdrop.pages.length || pages.some((page, index) =>
            page.width !== pdfBackdrop!.pages[index].width || page.height !== pdfBackdrop!.pages[index].height))) {
            throw new Error('PDF backdrop geometry does not match the pinned board');
        }
        let pageBounds: Rect | null = null;
        if (!selectionOnly && meta.kind !== 'whiteboard' && pages?.length) {
            let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
            for (const page of pages) {
                left = Math.min(left, page.x); top = Math.min(top, page.y);
                right = Math.max(right, page.x + page.width); bottom = Math.max(bottom, page.y + page.height);
            }
            pageBounds = { x: left, y: top, width: right - left, height: bottom - top };
        }
        const scope = resolveExportScope({ selection: selectedRoots, paged: meta.kind !== 'whiteboard',
            selectionBounds: () => inkBounds, sheetBounds: () => pageBounds ?? inkBounds }, route);
        let source = filtered;
        if (scope.includeBackdrop && meta.host.kind === 'notebook' && pages) {
            const paper = meta.host.paper, base = filtered;
            source = { token: base.token, sceneRevision: base.sceneRevision, nodeCount: pages.length + base.nodeCount,
                isCurrent: () => base.isCurrent(), readNode(index) {
                    if (index < pages.length) return { underlay: [...notebookBackdrop(paper, index, pages[index])], content: [] };
                    return base.readNode(index - pages.length);
                } };
        }
        const background = scope.includeBackdrop ? undefined : transparent ? undefined :
            DEFAULT_BOARD_PALETTES[meta.kind === 'whiteboard' ? theme : 'light'].background;
        const sheetName = meta.sheetOrder.length > 1 ? sheet.name : null;
        const pdfLayers = pdfBackdrop?.layers.map(layer => layer.id) ?? [];
        const pdfCapturer = (includeBoard: boolean) => {
            const backdrop = pdfBackdrop, pdfSource = pdfLease?.source;
            if (!backdrop || !pdfSource) throw new Error('The PDF backdrop source is unavailable');
            return createPlatformCapturer({ paneId: `native-export:${token.documentId}:${++serial}`, owner: token,
                snapshot(request, memory) {
                    const children: Array<{ snapshot: CaptureSnapshot; request: CaptureRequest }> = [];
                    const controller = new AbortController();
                    try {
                        const pdfRequest = { ...request, layers: pdfLayers };
                        const pdf = backdrop.captureSnapshot(pdfRequest, memory);
                        children.push({ snapshot: pdf, request: pdfRequest });
                        const pt = pdf.token, expected = pdfSource.source.token;
                        if (pt.documentId !== expected.documentId || pt.session !== expected.session || pt.vaultEpoch !== expected.vaultEpoch ||
                            pt.bytesGeneration !== expected.bytesGeneration) throw new Error('PDF capture source identity changed');
                        if (includeBoard) {
                            const boardRequest = { ...request, layers: ['board-underlay', 'board-content'] };
                            const board = createBoardCaptureSnapshot({ runtime, sheetId: selection.sheet, pin, request: boardRequest,
                                memory, onError: options.onError, readMedia: (entry, readSignal) => readBlob(entry.id, readSignal) });
                            children.push({ snapshot: board, request: boardRequest });
                        }
                        let closed = false;
                        active++;
                        return { token, revision: String(revision),
                            signal: AbortSignal.any([controller.signal, ...children.map(child => child.snapshot.signal)]),
                            layers: children.flatMap(child => child.snapshot.layers),
                            get isolation() { return children.every(child => child.snapshot.isolation !== undefined)
                                ? children.flatMap(child => child.snapshot.isolation ?? []) : undefined; },
                            async prepare(_request, renderRoute, captureSignal) {
                                let result: 'exact' | 'standin' | 'incomplete' = 'exact';
                                for (const child of children) {
                                    const status = await child.snapshot.prepare(child.request, renderRoute, captureSignal);
                                    if (status === 'incomplete') return status;
                                    if (status === 'standin') result = status;
                                }
                                return result;
                            },
                            release() {
                                if (closed) return; closed = true; controller.abort();
                                try {
                                    for (const child of children) {
                                        try { child.snapshot.release(); } catch (error) { try { options.onError(error); } catch { /* Release the other captures. */ } }
                                    }
                                } finally { active--; if (released) cleanup(); }
                            } };
                    } catch (error) {
                        controller.abort();
                        for (const child of children) { try { child.snapshot.release(); } catch { /* Preserve the original failure. */ } }
                        throw error;
                    }
                },
            });
        };
        const pdfPng = async (captureSignal: AbortSignal) => {
            const capturer = pdfCapturer(true);
            try {
                return await capturer.captureBlob(scope.bounds, Math.max(scope.bounds.width, scope.bounds.height) * 2,
                    { layers: [...pdfLayers, 'board-underlay', 'board-content'], theme: 'light', inverted: false, signal: captureSignal });
            } finally { capturer.dispose(); }
        };
        const pdfSvg = async (captureSignal: AbortSignal) => {
            if (!pages) throw new Error('PDF page geometry is unavailable');
            const now = performance.now();
            let live = 0;
            const cache = getPlatformRuntime().governor.register({ id: `pdf-svg-export:${token.documentId}:${++serial}`,
                owner: token, pool: 'cpu', kind: 'capture', class: 'critical', hiddenAt: null,
                lastVisibleAt: now, lastUsedAt: now, memory: () => ({ live, retiring: 0 }), evict: () => {} });
            const held: Array<Parameters<MemoryAllocator['release']>[0]> = [];
            const reserve = (bytes: number) => {
                const lease = cache.reserve(bytes);
                if (!lease) throw new Error('Insufficient shared memory for PDF SVG export');
                live += lease.bytes; held.push(lease); return lease;
            };
            const free = (lease: Parameters<MemoryAllocator['release']>[0]) => {
                const index = held.indexOf(lease);
                if (index >= 0) { held.splice(index, 1); cache.release(lease); live -= lease.bytes; }
            };
            const pageBlobs = new Map<string, Blob>(), pageItems: PaintImageItem[] = [];
            const capturer = pdfCapturer(false);
            try {
                for (let index = 0; index < pages.length; index++) {
                    captureSignal.throwIfAborted();
                    const page = pages[index], blob = await capturer.captureBlob(page, Math.max(page.width, page.height) * 2,
                        { layers: pdfLayers, theme: 'light', inverted: false, signal: captureSignal });
                    captureSignal.throwIfAborted();
                    reserve(blob.size);
                    const key = `pdf-page:${index}`; pageBlobs.set(key, blob);
                    pageItems.push({ kind: 'image', key, nodeId: key, geometryKey: key,
                        localToWorld: [1, 0, 0, 1, page.x, page.y], clips: [], imageKey: key,
                        rect: { x: 0, y: 0, width: page.width, height: page.height }, opacity: 1, blend: 'normal', inverted: false });
                }
                const pdfImages: PaintImageProvider = { async acquire(key, imageToken, imageSignal) {
                    const blob = pageBlobs.get(key);
                    if (!blob) return capturedImages.acquire(key, imageToken, imageSignal);
                    imageSignal.throwIfAborted();
                    const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
                    imageSignal.throwIfAborted();
                    if (blob.type !== 'image/png' || header.length !== 24 ||
                        ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)) throw new Error('Invalid captured PDF page PNG');
                    const view = new DataView(header.buffer), width = view.getUint32(16), height = view.getUint32(20);
                    if (!width || !height || !Number.isSafeInteger(width * height * 4)) throw new Error('Invalid captured PDF page dimensions');
                    const allocation = reserve(width * height * 4);
                    try {
                        const bitmap = await createImageBitmap(blob);
                        if (imageSignal.aborted || bitmap.width !== width || bitmap.height !== height) {
                            bitmap.close(); imageSignal.throwIfAborted(); throw new Error('Captured PDF page dimensions changed');
                        }
                        let closed = false;
                        return { source: bitmap, width, height, cpuBytes: allocation.bytes,
                            release() { if (!closed) { closed = true; bitmap.close(); free(allocation); } } };
                    } catch (error) { free(allocation); throw error; }
                } };
                const pageSource: PaintNodeSource = { token: source.token, sceneRevision: source.sceneRevision,
                    nodeCount: pageItems.length + source.nodeCount, isCurrent: () => source.isCurrent(),
                    readNode(index) { return index < pageItems.length ? { underlay: [pageItems[index]], content: [] } : source.readNode(index - pageItems.length); } };
                return await streamSvg(pageSource, scope.bounds, 2, createExportImageResolver(token, pdfImages,
                    (key, readSignal) => { readSignal.throwIfAborted(); const blob = pageBlobs.get(key); return blob ? Promise.resolve(blob) : readImage(key, readSignal); }, captureSignal), captureSignal);
            } finally {
                capturer.dispose();
                for (const lease of [...held]) free(lease);
                cache.close();
            }
        };
        const run = <T>(requestSignal: AbortSignal, work: (combined: AbortSignal) => Promise<T>): Promise<T> => {
            if (released) return Promise.reject(stale());
            active++;
            const combined = AbortSignal.any([requestSignal, lifetime.signal]);
            return Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined); }).finally(() => { active--; if (released) cleanup(); });
        };
        signal.addEventListener('abort', release, { once: true });
        if (signal.aborted) { release(); throw stale(); }
        return {
            png: requestSignal => run(requestSignal, combined => pdfBackdrop ? pdfPng(combined) :
                streamRasterPng(source, capturedImages, scope.bounds, 2, combined,
                    { background: background && colourCss(background), clipboard: route === 'copy' })),
            svg: requestSignal => run(requestSignal, combined => pdfBackdrop ? pdfSvg(combined) :
                streamSvg(source, scope.bounds, 2, createExportImageResolver(token, capturedImages, readImage, combined), combined, background)),
            filename: extension => exportFileName(boardName, sheetName, scope.kind, extension, timestamp),
            release,
        };
    } catch (error) { release(); throw error; }
}
