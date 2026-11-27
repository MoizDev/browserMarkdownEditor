import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import { createPlatformCapturer } from '../../platform/render/captureRuntime';
import type { CaptureRequest, CaptureSnapshot } from '../../platform/render/capture';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { Rect } from '../../platform/types';
import { createExportImageResolver } from '../export/exportImage';
import { createBoardCaptureSnapshot } from '../export/runtimeSnapshot';
import { encodeTiledPngInWorker } from '../export/pngWorkerClient';
import { checkPngSize, pngScaleLimit, splicePngDensity } from '../export/png';
import type { BoardPrintSource } from '../export/print';
import { streamIncrementalPdf, writeIncrementalPdfPage } from '../export/incrementalPdf';
import { createLazyIncrementalPdfWriter } from '../export/lazyPdfWriter';
import { exportFileName, resolveExportScope, type ExportRoute } from '../export/scope';
import { streamPageDisplayList } from '../export/streamPage';
import { streamRasterPng } from '../export/streamRaster';
import type { PdfInkSnapshot } from './pdfInkExport';
import { pinPdfInkAssembly } from './pdfInkAssembly';
import { streamSvg } from '../export/streamSvg';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaLease } from '../media/store';
import type { MediaEntry, MediaId } from '../model/media';
import type { NodeId, SheetId } from '../model/ids';
import { colourCss } from '../render/colour';
import { DEFAULT_BOARD_PALETTES } from '../render/palette';
import type { PaintImageProvider } from '../render/resources';
import type { PaintImageItem, PaintNodeSource } from '../render/paintStream';
import { measureBoardPaintBounds } from '../render/worldBounds';
import { notebookBackdrop } from './notebookBackdrop';
import { concatPaintSources } from './allSheetPaint';
import { inspectPdfVisualDoc, visualRefusal } from './pdfVisualPreflight';
import type { PdfInkSourceLease } from './pdfInkSourceOwner';
import type { BoardRuntime } from './runtime';
import { missingFromExport, type MissingMediaError } from '../media/missingMedia';

export type NativeExportRuntime = Readonly<{
    session: Pick<BoardRuntime['session'], 'doc' | 'owner'>;
    scene: BoardRuntime['scene'];
    selection: Pick<BoardRuntime['selection'], 'getSnapshot'>;
    render: BoardRuntime['render'];
    media: BoardRuntime['media'];
}>;

export interface NativeExportOptions {
    readonly runtime: NativeExportRuntime;
    readonly route: Extract<ExportRoute, 'copy' | 'context' | 'menu' | 'print'>;
    readonly boardName: string;
    readonly theme: 'light' | 'dark';
    readonly transparent: boolean;
    readonly signal: AbortSignal;
    readonly region?: Readonly<Rect>;
    readonly maxSide?: number;
    readonly selection?: Readonly<{ roots: readonly NodeId[]; excludeSubtrees: readonly NodeId[] }>;
    readonly wholeSheet?: boolean;
    readMedia?(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    current(): boolean;
    notice(message: string): void;
    onError(error: unknown): void;
    retainPdfSource?(): PdfInkSourceLease;
}

export interface NativeExportJob {
    png(signal: AbortSignal): Promise<Blob>;
    clipboardPng(signal: AbortSignal): Promise<Readonly<{ image: Blob; privateImage: Blob }>>;
    svg(signal: AbortSignal): Promise<Blob>;
    filename(extension: 'png' | 'svg' | 'pdf'): string;
    release(): void;
}

export interface NativePreparedExportJob extends NativeExportJob {
    readonly bounds: Readonly<Rect>;
    readonly topmostRoot: NodeId | null;
    readonly print: BoardPrintSource;
}

let serial = 0;
const stale = () => new DOMException('Board export ended', 'AbortError');

export async function prepareNativeExport(options: NativeExportOptions): Promise<NativePreparedExportJob> {
    const { runtime, signal, route, theme, transparent, boardName, maxSide } = options;
    const region = options.region ? { ...options.region } : undefined;
    if (region && (![region.x, region.y, region.width, region.height, region.x + region.width, region.y + region.height].every(Number.isFinite)
        || region.width <= 0 || region.height <= 0)) throw new RangeError('Invalid capture region');
    if (maxSide !== undefined && (!Number.isSafeInteger(maxSide) || maxSide < 1 || maxSide > 8192)) throw new RangeError('Invalid capture maximum side');
    const timestamp = new Date(), doc = runtime.session.doc, scene = runtime.scene;
    signal.throwIfAborted();
    if (!options.current() || !scene?.ready || scene.revision !== doc.rev) throw new Error('Board export scene is not ready');
    const selection = runtime.selection.getSnapshot(), revision = doc.rev, fontEpoch = runtime.render.text.fonts.epoch;
    if (region && options.selection) throw new TypeError('Explicit selection and capture region are mutually exclusive');
    const pagedPrint = route === 'print' && doc.kind !== 'whiteboard';
    const selectedRoots = options.selection ? [...options.selection.roots] : route === 'menu' || region || pagedPrint || options.wholeSheet ? [] : [...selection.selected];
    if (options.selection && !selectedRoots.length) throw new RangeError('Nothing to export');
    const excluded = new Set(options.selection?.excludeSubtrees), rootOf = new Map<NodeId, NodeId>();
    const selected = new Set<NodeId>(), pending = selectedRoots.map(id => ({ id, root: id }));
    const sheetNodes = doc.bySheet.get(selection.sheet);
    while (pending.length) {
        const { id, root } = pending.pop()!;
        if (selected.has(id) || excluded.has(id)) continue;
        const node = doc.nodes.get(id);
        if (!node || !sheetNodes?.has(id)) throw new Error('Export selection no longer belongs to this sheet');
        selected.add(id); rootOf.set(id, root);
        for (const child of doc.children.get(id) ?? []) pending.push({ id: child.id, root });
    }
    const selectionOnly = selectedRoots.length > 0;
    const visualNodes = new Set(selected);
    for (const id of selectedRoots) {
        let parent = doc.nodes.get(id)?.parent;
        for (let depth = 0; parent && depth <= 64; depth++) {
            const node = doc.nodes.get(parent as NodeId);
            if (!node) break;
            visualNodes.add(node.id); parent = node.parent;
        }
    }
    const mediaIds = new Set<MediaId>();
    for (const [id, references] of doc.mediaRefs) {
        for (const node of references) if (selectionOnly ? selected.has(node) : sheetNodes?.has(node)) { mediaIds.add(id); break; }
    }
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
        const entries = new Map<MediaId, MediaEntry>();
        for (const id of mediaIds) {
            const entry = meta.media.get(id);
            if (!entry) throw new Error(`Captured board media entry is unavailable: ${id}`);
            entries.set(id, structuredClone(entry));
        }
        const blobs = new Map<MediaId, Blob>(), missing = new Map<MediaId, MissingMediaError>();
        for (const [id, entry] of entries) {
            leases.push(runtime.media.retain(id, 'snapshot'));
            const blob = runtime.media.get(id) ?? await options.readMedia?.(entry, signal);
            signal.throwIfAborted();
            if (!blob && doc.kind !== 'pdf-ink') { missing.set(id, missingFromExport(entry)); continue; }
            if (!blob || blob.size !== entry.bytes) throw new Error(`Captured board media is unavailable: ${id}`);
            blobs.set(id, blob.slice(0, blob.size, blob.type));
        }
        const told = new Set<MediaId>();
        const token = pin.token;
        const readBlob = async (id: MediaId, readSignal: AbortSignal) => {
            readSignal.throwIfAborted();
            const blob = blobs.get(id), gone = missing.get(id);
            if (!released && gone) { if (!told.has(id)) { told.add(id); options.notice(gone.message); } throw gone; }
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
        const visual = await inspectPdfVisualDoc(frozenDoc, { signal: operationSignal,
            ...(selectionOnly ? { includeNodes: visualNodes } : {}) });
        if (visual.status !== 'known') throw new Error(visualRefusal(visual, route === 'print' ? 'printing it' : route === 'copy' ? 'copying it' : 'exporting it'));
        if (runtime.render.text.fonts.epoch !== fontEpoch) throw new Error('Board fonts changed while preparing the export; retry.');
        const raw = await pin.paintSource({ sheetId: selection.sheet, theme: meta.kind === 'whiteboard' ? theme : 'light', deviceScale: 2 }, operationSignal);
        operationSignal.throwIfAborted();
        if (runtime.render.text.fonts.epoch !== fontEpoch) throw new Error('Board fonts changed while preparing the export; retry.');
        let topmostRoot: NodeId | null = null, topmostIndex = -1;
        const selectOnly = (input: PaintNodeSource): PaintNodeSource => selectionOnly ? {
            token: input.token, sceneRevision: input.sceneRevision, nodeCount: input.nodeCount, isCurrent: () => input.isCurrent(),
            readNode(index) {
                const node = input.readNode(index);
                const underlay = node.underlay?.filter(item => selected.has(item.nodeId as NodeId));
                const content = node.content.filter(item => selected.has(item.nodeId as NodeId));
                return { underlay, content };
            },
        } : input;
        const filtered = selectOnly(raw);
        // PDF and print land on white paper with no background: a dark-theme paint
        // put near-white ink on it (seen: dark-mode Export → PDF was blank).
        const paperSource = meta.kind === 'whiteboard' && theme !== 'light'
            ? selectOnly(await pin.paintSource({ sheetId: selection.sheet, theme: 'light', deviceScale: 2 }, operationSignal)) : null;
        operationSignal.throwIfAborted();
        const now = performance.now();
        let live = 0;
        const cache = getPlatformRuntime().governor.register({ id: `board-export-bounds:${token.documentId}:${++serial}`,
            owner: token, pool: 'cpu', kind: 'capture', class: 'critical', hiddenAt: null,
            lastVisibleAt: now, lastUsedAt: now, memory: () => ({ live, retiring: 0 }), evict: () => {} });
        let inkBounds: Rect | null;
        try {
            const measured = await measureBoardPaintBounds(filtered, { signal: operationSignal,
                onPaintedItem(item, index) {
                    const root = rootOf.get(item.nodeId as NodeId);
                    if (root && index >= topmostIndex) { topmostIndex = index; topmostRoot = root; }
                }, memory: {
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
        const scope = region ? { kind: 'sheet' as const, ids: [], bounds: region, includeBackdrop: meta.kind !== 'whiteboard' }
            : resolveExportScope({ selection: selectedRoots, paged: meta.kind !== 'whiteboard',
                selectionBounds: () => inkBounds, sheetBounds: () => pageBounds ?? inkBounds }, route);
        const withBackdrop = (base: PaintNodeSource): PaintNodeSource => {
            if (!scope.includeBackdrop || meta.host.kind !== 'notebook' || !pages) return base;
            const paper = meta.host.paper;
            return { token: base.token, sceneRevision: base.sceneRevision, nodeCount: pages.length + base.nodeCount,
                isCurrent: () => base.isCurrent(), readNode(index) {
                    if (index < pages.length) return { underlay: [...notebookBackdrop(paper, index, pages[index])], content: [] };
                    return base.readNode(index - pages.length);
                } };
        };
        const source = withBackdrop(filtered);
        const sheetPaints = async (paintSignal: AbortSignal): Promise<PaintNodeSource[]> => {
            const parts: PaintNodeSource[] = [];
            for (const sheet of doc.sheetOrder) parts.push(await pin.paintSource({ sheetId: sheet.id, theme: 'light', deviceScale: 2 }, paintSignal));
            return parts;
        };
        let pagedPaint: Promise<PaintNodeSource> | undefined;
        const pagedSource = (): Promise<PaintNodeSource> => {
            pagedPaint ??= sheetPaints(operationSignal).then(parts => withBackdrop(concatPaintSources(parts)));
            return pagedPaint;
        };
        const background = region ? DEFAULT_BOARD_PALETTES[meta.kind === 'whiteboard' ? theme : 'light'].background
            : scope.includeBackdrop || transparent ? undefined : DEFAULT_BOARD_PALETTES[meta.kind === 'whiteboard' ? theme : 'light'].background;
        const longest = Math.max(scope.bounds.width, scope.bounds.height);
        const sizeLimit = pngScaleLimit(scope.bounds, route === 'copy');
        const naturalScale = Math.min(2, sizeLimit);
        const pngScale = maxSide === undefined ? naturalScale : Math.min(naturalScale, (maxSide - 1e-9) / longest);
        const pdfLayers = pdfBackdrop?.layers.map(layer => layer.id) ?? [];
        const pdfCapturer = (includeBoard: boolean) => {
            const backdrop = pdfBackdrop, pdfSource = pdfLease?.source;
            if (!backdrop || !pdfSource) throw new Error('The PDF backdrop source is unavailable');
            return createPlatformCapturer({ paneId: `native-export:${token.documentId}:${++serial}`, owner: token,
                encodePngTiles: (width, height, render, encodeOptions) => encodeTiledPngInWorker(width, height, render,
                    { session: `export:${token.session}:${revision}`, epoch: token.vaultEpoch, revision }, encodeOptions),
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
                            layers: [...(region && background ? [{ id: 'native-export-background', draw2d(ctx: CanvasRenderingContext2D) {
                                ctx.fillStyle = colourCss(background); ctx.fillRect(region.x, region.y, region.width, region.height);
                            } }] : []), ...children.flatMap(child => child.snapshot.layers)],
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
                            async prepareTile(tile, captureSignal) {
                                let result: 'exact' | 'standin' | 'incomplete' = 'exact';
                                for (const child of children) {
                                    const part = { ...tile, layers: child.request.layers };
                                    const status = child.snapshot.prepareTile
                                        ? await child.snapshot.prepareTile(part, captureSignal)
                                        : await child.snapshot.prepare(part, '2d', captureSignal);
                                    if (status === 'incomplete') return status;
                                    if (status === 'standin') result = status;
                                }
                                return result;
                            },
                            async release() {
                                if (closed) return; closed = true; controller.abort();
                                try {
                                    for (const child of children) {
                                        try { await child.snapshot.release(); } catch (error) { try { options.onError(error); } catch { /* Release the other captures. */ } }
                                    }
                                } finally { active--; if (released) cleanup(); }
                            } };
                    } catch (error) {
                        controller.abort();
                        for (const child of children) { try { void Promise.resolve(child.snapshot.release()).catch(() => {}); } catch { /* Preserve the original failure. */ } }
                        throw error;
                    }
                },
            });
        };
        const pdfCaptureBlob = async (world: Readonly<Rect>, pixelsPerUnit: number, layers: readonly string[],
            captureSignal: AbortSignal, clipboard: boolean): Promise<Blob> => {
            const backdrop = pdfBackdrop;
            if (!backdrop) throw new Error('The PDF backdrop is unavailable');
            const deadline = Date.now() + 300_000;
            for (;;) {
                const epoch = backdrop.fontEpoch();
                const capturer = pdfCapturer(true);
                try {
                    return await capturer.captureExportBlob(world, Math.max(world.width, world.height) * pixelsPerUnit,
                        { layers, theme: 'light', inverted: false, signal: captureSignal, deadlineMs: Math.max(1, deadline - Date.now()), clipboard, pixelsPerWorldUnit: pixelsPerUnit });
                } catch (error) {
                    captureSignal.throwIfAborted();
                    if (backdrop.fontEpoch() <= epoch || Date.now() >= deadline) throw error;
                } finally { await capturer.dispose(); }
            }
        };
        const pdfPng = async (captureSignal: AbortSignal) => {
            checkPngSize(Math.max(1, Math.ceil(scope.bounds.width * pngScale)), Math.max(1, Math.ceil(scope.bounds.height * pngScale)), route === 'copy');
            return pdfCaptureBlob(scope.bounds, pngScale,
                [...(region && background ? ['native-export-background'] : []), ...pdfLayers, 'board-underlay', 'board-content'], captureSignal, route === 'copy');
        };
        const pdfInkPrint = async (inkLease: PdfInkSourceLease, printSignal: AbortSignal): Promise<Uint8Array> => {
            const layout = pages;
            if (!layout || layout.length !== inkLease.source.pages.length) throw new Error('PDF page geometry is unavailable');
            const images = (imageSignal: AbortSignal) => createExportImageResolver(token, capturedImages, readImage, imageSignal);
            const pageSource = async (sheet: SheetId, index: number, pageSignal: AbortSignal) => {
                pageSignal.throwIfAborted();
                const world = layout[index];
                if (!world || !doc.sheetOrder.some(item => item.id === sheet)) throw new Error('Captured board page is unavailable');
                return { world, source: await pin.paintSource({ sheetId: sheet, page: index, world, theme: 'light' }, pageSignal) };
            };
            const ink: PdfInkSnapshot = { pages: inkLease.source.pages, sheets: doc.sheetOrder.map(item => item.id),
                async readSheetPage(sheet, index, pageSignal) {
                    const { world, source: paint } = await pageSource(sheet, index, pageSignal);
                    return streamPageDisplayList(paint, index, world, 1, images(pageSignal), pageSignal);
                },
                async writeSheetPage(sheet, index, sink, pageSignal) {
                    const { world, source: paint } = await pageSource(sheet, index, pageSignal);
                    await writeIncrementalPdfPage({ source: paint, world }, index, 1, images(pageSignal), sink, pageSignal);
                } };
            const assembly = pinPdfInkAssembly({ revision, source: inkLease.source.source,
                writeId: crypto.randomUUID().replace(/-/g, ''), ink, media: [...entries.values()],
                mediaBlob: id => blobs.get(id), isCurrent: () => !released && options.current(), release: () => {} },
                signal => inkLease.source.openWriter(signal));
            return assembly.printable(printSignal);
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
                    const page = pages[index], blob = await capturer.captureExportBlob(page, Math.max(page.width, page.height) * 2,
                        { layers: pdfLayers, theme: 'light', inverted: false, signal: captureSignal, deadlineMs: 300_000 });
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
                return await streamSvg(pageSource, scope.bounds, 1, createExportImageResolver(token, pdfImages,
                    (key, readSignal) => { readSignal.throwIfAborted(); const blob = pageBlobs.get(key); return blob ? Promise.resolve(blob) : readImage(key, readSignal); }, captureSignal), captureSignal);
            } finally {
                try { await capturer.dispose(); } finally {
                    for (const lease of [...held]) free(lease);
                    cache.close();
                }
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
        const exportPng = (requestSignal: AbortSignal) => run(requestSignal, combined => {
            if (route === 'copy' && pngScale < 2) options.notice('The copied PNG was scaled down to fit the clipboard size limit.');
            else if (route !== 'copy' && sizeLimit < 2 && pngScale < 2) options.notice('The PNG was scaled down to fit the image size limit.');
            return pdfBackdrop ? pdfPng(combined) : streamRasterPng(source, capturedImages, scope.bounds, pngScale, combined,
                { background: background && colourCss(background), clipboard: route === 'copy' });
        });
        const printPages: Rect[] = !selectionOnly && meta.kind !== 'whiteboard' && pages?.length
            ? pages.map(page => ({ ...page })) : [{ ...scope.bounds }];
        const printScale = meta.kind === 'whiteboard' ? 0.75 : 1, printRaster = meta.kind === 'whiteboard' ? 200 / 96 : 200 / 72;
        const print: BoardPrintSource = {
            pageCount: printPages.length,
            pdf: requestSignal => run(requestSignal, async combined => {
                if (pdfLease) return new Blob([(await pdfInkPrint(pdfLease, combined)).slice().buffer], { type: 'application/pdf' });
                const content = meta.kind === 'whiteboard' ? (paperSource ?? source) : await pagedSource();
                const bytes = await streamIncrementalPdf({ revision, pageCount: printPages.length,
                    async page(index, pageSignal) {
                        pageSignal.throwIfAborted();
                        return { source: content, world: printPages[index]!, outputScale: printScale };
                    } }, printScale, createExportImageResolver(token, capturedImages, readImage, combined), createLazyIncrementalPdfWriter(), combined);
                combined.throwIfAborted();
                return new Blob([bytes.slice().buffer], { type: 'application/pdf' });
            }),
            pngPage: (page, requestSignal, maxSide) => run(requestSignal, async combined => {
                const world = printPages[page];
                if (!Number.isSafeInteger(page) || !world) throw new RangeError('Invalid print page');
                if (maxSide !== undefined && (!Number.isSafeInteger(maxSide) || maxSide < 1 || maxSide > 8192)) throw new RangeError('Invalid print page maximum side');
                // A print page is decoded by the print viewer in this renderer, so it keeps the clipboard's budget: a
                // download may be far larger, but a 200 dpi page past this bound would crash the page instead of printing.
                const sideLimit = maxSide === undefined ? Infinity : (maxSide - 1e-9) / Math.max(world.width, world.height);
                const raster = Math.min(printRaster, pngScaleLimit(world, true), sideLimit);
                if (pdfBackdrop) return pdfCaptureBlob(world, raster, [...pdfLayers, 'board-underlay', 'board-content'], combined, false);
                const content = meta.kind === 'whiteboard' ? (paperSource ?? source) : await pagedSource();
                return streamRasterPng(content, capturedImages, world, raster, combined, { background: '#ffffff' });
            }),
            release,
        };
        return {
            bounds: Object.freeze({ ...scope.bounds }), topmostRoot, print,
            png: exportPng,
            clipboardPng: async requestSignal => {
                const image = await exportPng(requestSignal);
                return Object.freeze({ image, privateImage: await splicePngDensity(image, scope.bounds, requestSignal) });
            },
            svg: requestSignal => run(requestSignal, combined => pdfBackdrop ? pdfSvg(combined) :
                streamSvg(source, scope.bounds, 1, createExportImageResolver(token, capturedImages, readImage, combined), combined, background)),
            filename: extension => exportFileName(boardName, scope.kind, extension, timestamp),
            release,
        };
    } catch (error) { release(); throw error; }
}
