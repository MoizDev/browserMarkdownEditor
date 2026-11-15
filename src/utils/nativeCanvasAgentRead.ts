import type { AgentHostDeps } from './agentHost';
import type { NativeCanvasView, VaultToolHost } from '../types/vaultAgent';
import { isNativeDrawingFile, isNotebookFile, isPdfFile } from './fileTypes';
import { createNativeAgentReader } from '../whiteboard/host/nativeAgentRead';
import { readNativeAgentViewport } from '../whiteboard/host/nativeAgentView';
import { readClosedAgentProjection } from '../whiteboard/host/agentProjection';
import { getPdfInkSourceState } from '../whiteboard/host/preparePdfInkSession';
import type { PdfInkAcquisition } from '../pdf/session/inkAcquisition.types';
import type { Rect } from '../platform/types';
import { MEDIA_MIMES, type MediaEntry, type MediaMime } from '../whiteboard/model/media';
import { mediaExtension } from '../whiteboard/media/ingest';
import { acquireNativeBoard } from '../whiteboard/host/nativeAcquisition';
import { createClosedBoardSource, type ClosedBoardSource } from '../whiteboard/host/closedBoardScene';
import { prepareNativeExport } from '../whiteboard/host/nativeExport';
import type { ClosedCanvasSourceLease } from './closedCanvasSource';

/** Loaded only by an actual canvas tool request; source ownership stays in App. */
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
        // Classic is a separate representation, not a recovery path for failed native reads; a PDF has none.
        if (kind !== 'pdf' && !tab.representation.nativeCanvasKind && !isNativeDrawingFile(path)) return null;
        if (!deps.ensureNativeAgentRuntime) throw new Error('Native canvas source acquisition is unavailable');
        // Keep the existing agent readiness bound without imposing that timer
        // on the immutable read after App has returned its actual session.
        const readiness = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const source = await deps.ensureNativeAgentRuntime(path, readiness);
        check();
        if (!source.isCurrent()) throw new DOMException('Canvas session changed', 'AbortError');
        // A PDF page capture pins the App-owned PDF source of this exact document, the same
        // source the clipboard uses; a refusal here is explicit, never a blank backdrop.
        const pdfInk = source.identity.kind === 'pdfInk', documentId = source.identity.documentId;
        return createNativeAgentReader({ runtime: source.runtime,
            ...(pdfInk ? { retainPdfSource: () => {
                const pdf = getPdfInkSourceState(documentId);
                if (!pdf || !source.isCurrent()) throw new Error('The PDF ink source is unavailable');
                if (pdf.getSnapshot().status !== 'ready') throw new Error('The PDF source is updating');
                return pdf.retainSource();
            } } : {}),
            // App's canonical pending-or-disk media reader: the export producer uses it for embedded pictures.
            readMedia: (entry, mediaSignal) => source.readMedia(entry, mediaSignal),
            isCurrent: () => guard.isCurrent() && source.isCurrent(), notice: deps.notify,
            onError: error => console.error('Native canvas tool capture failed:', error),
        }).shapes({ ...options.query }, job);
    }
    if (!options.handle || !deps.acquireClosedCanvasSource) return null;
    if (isPdfFile(path)) return readClosedPdfInkShapes({ deps, path, handle: options.handle, query: options.query, guard, signal });
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
        // Only the producer's complete OTHER result authorizes the existing Classic reader.
        // Native refusals throw without reparsing, changing kind or constructing blank content.
        return result.kind === 'other' ? null : result.page;
    } finally { await lease.release(); }
}

/** An open native drawing's view with no mounted pane. The caller has established that the tab is open natively. */
export async function readNativeCanvasView(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
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
    const reader = createNativeAgentReader({ runtime: source.runtime,
        readMedia: (entry, mediaSignal) => source.readMedia(entry, mediaSignal),
        isCurrent, notice: deps.notify, onError: error => console.error('Native canvas view failed:', error) });
    const job = { signal, deadlineMs: 30_000 };
    // Read the recorded state before describing: a never-viewed board has no camera and its view is the whole sheet.
    const wholeSheet = !readNativeAgentViewport(source.runtime);
    const info = await reader.describe(job);
    check();
    if (info.kind !== 'drawing') throw new Error('The open native canvas is not a drawing');
    return { info, wholeSheet, capture: async (maxSide, captureSignal) => {
        const requestSignal = captureSignal ? AbortSignal.any([signal, captureSignal]) : signal;
        const { x, y, w, h } = info.viewport;
        return reader.capture({ x, y, width: w, height: h }, maxSide, { signal: requestSignal, deadlineMs: 30_000 });
    } };
}

/** A closed PDF's ink board comes from the admitted outer PDF (never a pane, legacy JSON or a blank fallback).
 * A plain PDF is eligible for a genuine verified-empty board; any read-only admission is a refusal. */
async function readClosedPdfInkShapes(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly handle: FileSystemFileHandle;
    readonly query: Parameters<NonNullable<VaultToolHost['canvasShapePage']>>[1];
    readonly guard: Parameters<NonNullable<VaultToolHost['canvasShapePage']>>[2];
    readonly signal: AbortSignal;
}): ReturnType<NonNullable<VaultToolHost['canvasShapePage']>> {
    const { deps, path, handle, query, guard, signal } = options;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Canvas tool source changed', 'AbortError');
    };
    if (!deps.acquireClosedCanvasSource) return null;
    const lease = await deps.acquireClosedCanvasSource(path, handle, 'pdf-ink', { signal, isCurrent: guard.isCurrent });
    let admitted: PdfInkAcquisition | undefined;
    try {
        check();
        const [{ acquirePdfInkSource }, { createPdfInkHost }, { createEmptyNativeBytes }] = await Promise.all([
            import('../pdf/session/inkAcquisition'), import('../pdf/session/inkHost'), import('../whiteboard/host/emptyNative'),
        ]);
        admitted = await acquirePdfInkSource({ outer: lease.bytes, token: lease.token, signal: lease.signal,
            isCurrent: () => lease.isCurrent() && guard.isCurrent() });
        check();
        if (admitted.kind === 'read-only') throw new Error(`PDF ink cannot be read as a canvas: ${admitted.reason}`);
        const board = admitted.kind === 'plain'
            ? createEmptyNativeBytes('pdf-ink', { pdfHost: createPdfInkHost(admitted) }) : admitted.board;
        const job = { signal: lease.signal, deadlineMs: 30_000 };
        const result = await readClosedAgentProjection({ bytes: board, kind: 'pdf-ink',
            pdfPages: admitted.pages.map(page => [page.width, page.height] as const), diskRevision: lease.diskRevision,
            token: lease.token, authority: lease.authority, query: { ...query }, job,
            isCurrent: () => guard.isCurrent() && lease.isCurrent(), assertBaseline: lease.assertBaseline });
        check();
        // Only a complete OTHER result may use the legacy route; a PDF has none, so it is simply not a canvas.
        return result.kind === 'other' ? null : result.page;
    } finally {
        try { await admitted?.release(); } finally { await lease.release(); }
    }
}

/** A closed native ink PDF's whole-sheet picture: the canonical paint bounds and the physical page count. It has no
 * camera: a closed board was never viewed, so its picture is the whole sheet as the board lays its pages out. */
export interface NativePdfPicture {
    readonly png: Blob;
    readonly bounds: Readonly<Rect>;
    readonly pageCount: number;
}

/** Only an ADMITTED native ink board is pictured here. A plain, notebook or ordinary PDF returns null and keeps its
 * closed text/view route. A claimed board (annotated, ambiguous or newer) that fails admission throws, never falls back. */
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
        const { acquirePdfInkSource } = await import('../pdf/session/inkAcquisition');
        admitted = await acquirePdfInkSource({ outer: lease.bytes, token: lease.token, signal: lease.signal,
            isCurrent: () => lease.isCurrent() && guard.isCurrent() });
        check();
        if (admitted.kind === 'plain') return null;
        if (admitted.kind === 'read-only') {
            const { inspectPdfRole } = await import('./pdfAttachmentInventory');
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

/** The admitted native board's canonical whole-sheet picture, through the same export producer a live capture uses. */
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
        // A PDF's embedded media lives inside its admitted source under its board-media name.
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

/** An OPEN native ink PDF's whole-sheet picture from its LIVE session: the same canonical producer, the session's
 * own render parts and its own PDF source lease. No view is mounted and no second session is opened. */
export async function readOpenNativePdfPicture(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly maxSide: number;
    readonly guard: Parameters<NonNullable<VaultToolHost['nativePdfPicture']>>[2];
}): Promise<NativePdfPicture | null> {
    const { deps, path, maxSide, guard } = options;
    const signal = guard.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Canvas picture source changed', 'AbortError');
    };
    if (!deps.ensureNativeAgentRuntime) throw new Error('Native canvas source acquisition is unavailable');
    const source = await deps.ensureNativeAgentRuntime(path, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    check();
    if (!source.isCurrent()) throw new DOMException('Canvas session changed', 'AbortError');
    const { getPdfInkSourceState } = await import('../whiteboard/host/preparePdfInkSession');
    const state = getPdfInkSourceState(source.identity.documentId);
    if (!state) throw new Error('The open PDF ink source is unavailable.');
    const lease = state.retainSource();
    try {
        const runtime = source.runtime;
        const capture = await prepareNativeExport({ runtime, route: 'menu', boardName: 'Picture', theme: 'light', transparent: false,
            maxSide, signal, current: () => guard.isCurrent() && source.isCurrent(), notice: deps.notify,
            onError: error => console.error('Open PDF ink picture failed:', error),
            readMedia: (entry, mediaSignal) => source.readMedia(entry, mediaSignal), retainPdfSource: () => lease });
        try {
            const png = await capture.png(signal);
            check();
            const host = runtime.session.doc.host;
            if (host.kind !== 'pdf-ink') throw new Error('The open PDF is not an ink board');
            return { png, bounds: { ...capture.bounds }, pageCount: host.pages.length };
        } finally { capture.release(); }
    } finally { lease.release(); }
}
