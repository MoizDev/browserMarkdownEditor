import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { removeNotebookExporter, setNotebookRenderData, type NativeNotebookExporter } from '../../utils/notebookRenderCache';
import { getSessionIdentity } from '../../utils/sessionIdentity';
import type { DisplayPdfWriter } from '../export/capturePdf';
import type { ComposedBoardSession } from '../session/factoryTypes';
import { exportNotebookPdf } from './notebookExport';
import { pinNativeNotebookExport } from './notebookExportCapture';
import { getBoardRuntime } from './runtime';

export type NativeNotebookDisplayWriter = (input: Parameters<DisplayPdfWriter>[0],
    options: { readonly signal?: AbortSignal; readonly revision: number }) => Promise<Uint8Array>;

const slot = Symbol('native notebook exporter');

/** The session owns the exporter; pane hiding, graph view and remount never remove it. */
export function registerNativeNotebookExporter(options: {
    board: ComposedBoardSession;
    host: NativeCanvasHost;
    identity: NativeCanvasIdentity;
    writer: NativeNotebookDisplayWriter;
    onError(error: unknown): void;
}): void {
    const { board, host, identity } = options;
    const owner = getSessionIdentity(identity.documentId), runtime = getBoardRuntime(board);
    if (!owner || owner.serial !== identity.session || identity.kind !== 'notebook' ||
        board.owner.documentId !== identity.documentId || board.owner.session !== identity.session ||
        board.doc.kind !== 'notebook' || !runtime || !host.isCurrent(identity)) throw new Error('Notebook exporter requires its current native session');
    const existing = owner.getSlot<{ board: ComposedBoardSession; exporter: NativeNotebookExporter }>(slot);
    if (existing) {
        if (existing.board !== board) throw new Error('Notebook exporter belongs to another board');
        const path = host.identity(identity.documentId)?.path;
        if (!path) throw new Error('Notebook path is unavailable');
        removeNotebookExporter(existing.exporter); setNotebookRenderData(path, existing.exporter);
        return;
    }
    let disposed = false;
    const jobs = new Set<() => void>(), running = new Set<Promise<void>>(), cleanupErrors: unknown[] = [];
    const exporter: NativeNotebookExporter = {
        kind: 'native',
        prepare() {
            const latest = host.identity(identity.documentId);
            if (disposed || !latest || latest.kind !== 'notebook' || latest.session !== identity.session ||
                latest.vaultActivation !== identity.vaultActivation || !host.isCurrent(identity) || getBoardRuntime(board) !== runtime ||
                getSessionIdentity(identity.documentId)?.serial !== identity.session) throw new Error('Notebook session is no longer current');
            const sourcePath = latest.path, revision = board.doc.rev;
            const isCurrent = () => {
                const current = host.identity(identity.documentId);
                return !disposed && !!current && current.kind === 'notebook' && current.path === sourcePath && current.session === identity.session &&
                    current.vaultActivation === identity.vaultActivation && host.isCurrent(identity) &&
                    getSessionIdentity(identity.documentId)?.serial === identity.session && getBoardRuntime(board) === runtime;
            };
            const pin = pinNativeNotebookExport({ runtime, revision, current: isCurrent, onError: options.onError });
            const controller = new AbortController();
            let released = false, active = false, used = false, pinReleased = false;
            const releasePin = () => {
                if (pinReleased) return;
                pinReleased = true; jobs.delete(release);
                try { pin.release(); } catch (error) { cleanupErrors.push(error); throw error; }
            };
            const release = () => {
                if (released) return;
                released = true; controller.abort();
                if (!active) releasePin();
            };
            jobs.add(release);
            return {
                sourcePath, isCurrent: () => !released && isCurrent(),
                run(signal) {
                    if (used || released || !isCurrent()) throw new DOMException('Notebook export is no longer current', 'AbortError');
                    used = true; active = true;
                    const combined = AbortSignal.any([signal, controller.signal]);
                    const work = (async () => {
                        try {
                            combined.throwIfAborted();
                            const bytes = await exportNotebookPdf(pin.snapshot, sourcePath,
                                (input, writerOptions) => options.writer(input, { ...writerOptions, revision: pin.revision }), combined);
                            combined.throwIfAborted();
                            if (released || !isCurrent()) throw new DOMException('Notebook export is no longer current', 'AbortError');
                            return { paper: { ...pin.snapshot.paper }, bytes };
                        } finally { active = false; if (released) releasePin(); }
                    })();
                    const settled = work.then(() => {}, () => {});
                    running.add(settled);
                    void settled.then(() => { running.delete(settled); });
                    return work;
                },
                release,
            };
        },
    };
    const path = host.identity(identity.documentId)?.path;
    if (!path) throw new Error('Notebook path is unavailable');
    owner.setSlot(slot, { board, exporter }, async value => {
        disposed = true;
        removeNotebookExporter(value.exporter);
        for (const release of [...jobs]) { try { release(); } catch { /* The release recorded its failure. */ } }
        await Promise.all([...running]);
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Notebook export cleanup failed');
    });
    setNotebookRenderData(path, exporter);
}
