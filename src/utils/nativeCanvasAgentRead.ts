import type { AgentHostDeps } from './agentHost';
import type { NativeCanvasView, VaultToolHost } from '../types/vaultAgent';
import { isNativeDrawingFile, isNotebookFile, isPdfFile } from './fileTypes';
import { createNativeAgentReader } from '../whiteboard/host/nativeAgentRead';
import { readNativeAgentViewport } from '../whiteboard/host/nativeAgentView';
import { readClosedAgentProjection } from '../whiteboard/host/agentProjection';
import type { PdfInkAcquisition } from '../pdf/session/inkAcquisition.types';

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
        return createNativeAgentReader({ runtime: source.runtime,
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
