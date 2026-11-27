import type { AgentHostDeps } from './agentHost';
import type { NativeCanvasView, VaultToolHost } from '../types/vaultAgent';
import { isNotebookFile, isPdfFile } from './fileTypes';
import { createNativeAgentReader } from '../whiteboard/host/nativeAgentRead';
import { readNativeAgentViewport } from '../whiteboard/host/nativeAgentView';
import { readClosedAgentProjection } from '../whiteboard/host/agentProjection';
import type { PdfInkAcquisition } from '../pdf/session/inkAcquisition.types';
import type { Rect } from '../platform/types';
import { MEDIA_MIMES, type MediaEntry, type MediaMime } from '../whiteboard/model/media';
import { mediaExtension } from '../whiteboard/media/ingest';
import { acquireNativeBoard } from '../whiteboard/host/nativeAcquisition';
import { createClosedBoardSource, type ClosedBoardSource } from '../whiteboard/host/closedBoardScene';
import { prepareNativeExport } from '../whiteboard/host/nativeExport';
import type { ClosedCanvasSourceLease } from './closedCanvasSource';
import { getPdfInkSourceState } from '../whiteboard/host/preparePdfInkSession';
import { boardPageStack } from '../whiteboard/model/pages';
import { loadChunk } from '../platform/chunkLoad';

export async function readNativeCanvasShapePage(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly handle?: FileSystemFileHandle;
    readonly query: Parameters<NonNullable<VaultToolHost['canvasShapePage']>>[1];
    readonly guard: Parameters<NonNullable<VaultToolHost['canvasShapePage']>>[2];
}): ReturnType<NonNullable<VaultToolHost['canvasShapePage']>> {
    const { deps, path, guard } = options;
    const signal = guard.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Canvas tool source changed', 'AbortError');
    };
    check();
    const tab = deps.tabs.find(tab => tab.file.path === path);
    const job = { signal, deadlineMs: 30_000 };
    if (tab) {
        const kind = tab.representation.loadedKind;
        if (kind !== 'drawing' && kind !== 'notebook' && kind !== 'pdf') return null;
        if (!deps.ensureNativeAgentRuntime) throw new Error('Native canvas source acquisition is unavailable');
        const readiness = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const source = await deps.ensureNativeAgentRuntime(path, readiness);
        check();
        if (!source.isCurrent()) throw new DOMException('Canvas session changed', 'AbortError');
        const pdfInk = source.identity.kind === 'pdfInk', documentId = source.identity.documentId;
        return createNativeAgentReader({ runtime: source.runtime,
            readMedia: (entry, mediaSignal) => source.readMedia(entry, mediaSignal),
            ...(pdfInk ? { retainPdfSource: () => {
                const pdf = getPdfInkSourceState(documentId);
                if (!pdf || !source.isCurrent()) throw new Error('The PDF ink source is unavailable');
                if (pdf.getSnapshot().status !== 'ready') throw new Error('The PDF source is updating');
                return pdf.retainSource();
            } } : {}),
            isCurrent: () => guard.isCurrent() && source.isCurrent(), notice: deps.notify,
            onError: error => console.error('Native canvas tool capture failed:', error),
        }).shapes({ ...options.query }, job);
    }
    if (!options.handle || !deps.acquireClosedCanvasSource) return null;
    if (isPdfFile(path)) return null;
    const lease = await deps.acquireClosedCanvasSource(path, options.handle,
        isNotebookFile(path) ? 'notebook' : 'drawing', { signal, isCurrent: guard.isCurrent });
    try {
        check();
        const result = await readClosedAgentProjection({ bytes: lease.bytes,
            kind: isNotebookFile(path) ? 'notebook' : 'whiteboard', token: lease.token,
            diskRevision: lease.diskRevision, authority: lease.authority, query: { ...options.query },
            job: { ...job, signal: lease.signal },
            isCurrent: () => guard.isCurrent() && lease.isCurrent(),
            assertBaseline: lease.assertBaseline,
        });
        check();
        return result.kind === 'other' ? null : result.page;
    } finally { await lease.release(); }
}

export async function readNativeCanvasView(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly storedPage?: number;
    readonly guard: Parameters<NonNullable<VaultToolHost['nativeCanvasView']>>[1];
}): Promise<NativeCanvasView> {
    const { deps, path, guard } = options;
    const signal = guard.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Canvas view source changed', 'AbortError');
    };
    check();
    if (!deps.ensureNativeAgentRuntime) throw new Error('Native canvas source acquisition is unavailable');
    const source = await deps.ensureNativeAgentRuntime(path, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    check();
    if (!source.isCurrent()) throw new DOMException('Canvas session changed', 'AbortError');
    const isCurrent = () => guard.isCurrent() && source.isCurrent();
    const pdfInk = source.identity.kind === 'pdfInk', documentId = source.identity.documentId;
    const reader = createNativeAgentReader({ runtime: source.runtime,
        readMedia: (entry, mediaSignal) => source.readMedia(entry, mediaSignal),
        ...(pdfInk ? { retainPdfSource: () => {
            const pdf = getPdfInkSourceState(documentId);
            if (!pdf || !source.isCurrent()) throw new Error('The PDF ink source is unavailable');
            if (pdf.getSnapshot().status !== 'ready') throw new Error('The PDF source is updating');
            return pdf.retainSource();
        } } : {}),
        isCurrent, notice: deps.notify, onError: error => console.error('Native canvas view failed:', error) });
    const job = { signal, deadlineMs: 30_000 };
    const recorded = readNativeAgentViewport(source.runtime);
    const info = await reader.describe(job, options.storedPage);
    check();
    return { info, wholeSheet: !recorded, capture: async (maxSide, captureSignal, page, region) => {
        const requestSignal = captureSignal ? AbortSignal.any([signal, captureSignal]) : signal;
        const captureJob = { signal: requestSignal, deadlineMs: 30_000 };
        if (page !== undefined) {
            const rect = reader.pageRect(page);
            if (!rect) throw new RangeError(`page ${page} is not on this board`);
            if (region) return reader.capture({ x: rect.x + region.x, y: rect.y + region.y, width: region.w, height: region.h }, maxSide, captureJob);
            return reader.capture(rect, maxSide, captureJob);
        }
        if (region) return reader.capture({ x: region.x, y: region.y, width: region.w, height: region.h }, maxSide, captureJob);
        if (info.kind === 'drawing') {
            const { x, y, w, h } = info.viewport;
            return reader.capture({ x, y, width: w, height: h }, maxSide, captureJob);
        }
        return reader.capture(recorded?.region, maxSide, captureJob);
    } };
}

export interface NativePdfPicture {
    readonly png: Blob;
    readonly bounds: Readonly<Rect>;
    readonly pageCount: number;
}

export async function readNativePdfPicture(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly handle: FileSystemFileHandle;
    readonly maxSide: number;
    readonly guard: Parameters<NonNullable<VaultToolHost['nativePdfPicture']>>[2];
}): Promise<NativePdfPicture | null> {
    const { deps, path, handle, maxSide, guard } = options;
    const signal = guard.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Canvas picture source changed', 'AbortError');
    };
    if (!deps.acquireClosedCanvasSource) return null;
    const lease = await deps.acquireClosedCanvasSource(path, handle, 'pdf-ink', { signal, isCurrent: guard.isCurrent });
    let admitted: PdfInkAcquisition | undefined;
    try {
        check();
        const { acquirePdfInkSource } = await loadChunk(() => import('../pdf/session/inkAcquisition'));
        admitted = await acquirePdfInkSource({ outer: lease.bytes, token: lease.token, signal: lease.signal,
            isCurrent: () => lease.isCurrent() && guard.isCurrent() });
        check();
        if (admitted.kind === 'plain') return null;
        if (admitted.kind === 'read-only') {
            const { inspectPdfRole } = await loadChunk(() => import('./pdfAttachmentInventory'));
            const role = await inspectPdfRole(new Uint8Array(await lease.bytes.arrayBuffer()), String(lease.token.bytesGeneration));
            check();
            if (role.kind === 'annotated' || role.kind === 'ambiguous' || role.kind === 'newer') {
                throw new Error(`The PDF's ink board cannot be read safely: ${admitted.reason}`);
            }
            return null;
        }
        return await captureAdmittedPdfInk({ admitted, lease, maxSide, signal, isCurrent: () => guard.isCurrent(),
            notice: deps.notify, onError: error => console.error('Closed PDF ink picture failed:', error) });
    } finally {
        try { await admitted?.release(); } finally { await lease.release(); }
    }
}

async function captureAdmittedPdfInk(options: {
    readonly admitted: Extract<PdfInkAcquisition, { kind: 'native' }>;
    readonly lease: ClosedCanvasSourceLease;
    readonly maxSide: number;
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    notice(message: string): void;
    onError(error: unknown): void;
}): Promise<NativePdfPicture> {
    const { admitted: pdf, lease, signal } = options;
    const check = () => {
        signal.throwIfAborted();
        if (!options.isCurrent() || !lease.isCurrent()) throw new DOMException('Closed PDF picture source changed', 'AbortError');
    };
    let acquired: Awaited<ReturnType<typeof acquireNativeBoard>> | undefined, source: ClosedBoardSource | undefined;
    try {
        const readMedia = (entry: MediaEntry, mediaSignal: AbortSignal) => {
            const mime = MEDIA_MIMES.find(value => value === entry.mime);
            if (!mime) throw new Error(`Invalid embedded PDF media: ${entry.id}`);
            return pdf.readMedia(`board-media/${entry.id.slice(7)}.${mediaExtension(mime as MediaMime)}`, mediaSignal);
        };
        acquired = await acquireNativeBoard({ bytes: pdf.board, kind: 'pdf-ink',
            pdfPages: pdf.pages.map(page => [page.width, page.height] as const),
            identity: { session: `${lease.token.documentId}:${lease.token.session}`, epoch: lease.token.vaultEpoch,
                generation: lease.token.bytesGeneration },
            signal, deadlineMs: 30_000 });
        check();
        if (acquired.status !== 'editable') throw new Error('The PDF ink board cannot be pictured safely');
        source = await createClosedBoardSource({ doc: acquired.load.doc, samples: acquired.samples, token: lease.token,
            readMedia, signal, onError: options.onError });
        check();
        const capture = await prepareNativeExport({ runtime: source.runtime, route: 'menu', boardName: 'Picture', theme: 'light',
            transparent: false, maxSide: options.maxSide, signal, current: () => options.isCurrent() && lease.isCurrent(),
            notice: options.notice, onError: options.onError, readMedia,
            retainPdfSource: () => ({ source: pdf, release() {} }) });
        try {
            const png = await capture.png(signal);
            check();
            return { png, bounds: { ...capture.bounds }, pageCount: pdf.pages.length };
        } finally { capture.release(); }
    } finally {
        try { source?.dispose(); } finally { acquired?.dispose(); }
    }
}

export interface NativeClosedCanvasPicture {
    readonly png: Blob;
    readonly count: number;
    readonly wholeSheet: boolean;
    readonly page?: number;
}

export async function readNativeClosedCanvasPicture(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly handle: FileSystemFileHandle;
    readonly page?: number;
    readonly maxSide: number;
    readonly guard: { readonly signal?: AbortSignal; isCurrent(): boolean };
}): Promise<NativeClosedCanvasPicture | null> {
    const { deps, path, handle, page, maxSide, guard } = options;
    const signal = guard.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Closed canvas picture source changed', 'AbortError');
    };
    if (!deps.acquireClosedCanvasSource || !deps.readClosedCanvasMedia) return null;
    const notebook = isNotebookFile(path);
    const lease = await deps.acquireClosedCanvasSource(path, handle, notebook ? 'notebook' : 'drawing', { signal, isCurrent: guard.isCurrent });
    let acquired: Awaited<ReturnType<typeof acquireNativeBoard>> | undefined, source: ClosedBoardSource | undefined;
    try {
        check();
        acquired = await acquireNativeBoard({ bytes: lease.bytes, kind: notebook ? 'notebook' : 'whiteboard',
            identity: { session: `${lease.token.documentId}:${lease.token.session}`, epoch: lease.token.vaultEpoch,
                generation: lease.token.bytesGeneration },
            signal: lease.signal, deadlineMs: 30_000 });
        check();
        if (acquired.status === 'read-only') {
            if (acquired.report.complete && acquired.report.format === 'other') return null;
            throw new Error('The canvas cannot be pictured safely without its original bytes');
        }
        const doc = acquired.load.doc;
        const stack = boardPageStack(doc.host);
        const count = doc.kind === 'notebook' ? (stack?.rects.length ?? 0) : doc.sheetOrder.length;
        if (page !== undefined && (doc.kind !== 'notebook' || !Number.isSafeInteger(page) || page < 1 || page > count)) {
            throw new RangeError(`page ${page} is past the end of "${path}", which has ${count} page${count === 1 ? '' : 's'}.`);
        }
        const region = page !== undefined ? stack?.rects[page - 1] : undefined;
        const readMedia = async (entry: MediaEntry, mediaSignal: AbortSignal) => {
            const blob = await deps.readClosedCanvasMedia!(path, handle, entry, mediaSignal);
            if (!blob) throw new Error(`The board's picture is missing: ${entry.file}`);
            return blob;
        };
        source = await createClosedBoardSource({ doc, samples: acquired.samples, token: lease.token, readMedia, signal: lease.signal,
            onError: error => console.error('Closed canvas picture failed:', error) });
        check();
        const capture = await prepareNativeExport({ runtime: source.runtime, route: 'menu', boardName: 'Picture', theme: 'light',
            transparent: false, maxSide, signal: lease.signal, ...(region ? { region: { ...region } } : {}),
            current: () => guard.isCurrent() && lease.isCurrent(), notice: deps.notify,
            onError: error => console.error('Closed canvas picture failed:', error), readMedia });
        try {
            const png = await capture.png(lease.signal);
            check();
            return { png, count, wholeSheet: !region, ...(page !== undefined ? { page } : {}) };
        } finally { capture.release(); }
    } finally {
        try { source?.dispose(); } finally { try { acquired?.dispose(); } finally { await lease.release(); } }
    }
}
