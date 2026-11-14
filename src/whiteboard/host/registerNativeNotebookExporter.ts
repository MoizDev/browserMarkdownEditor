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
    const exporter: NativeNotebookExporter = {
        kind: 'native',
        prepare() {
            const latest = host.identity(identity.documentId);
            if (!latest || latest.kind !== 'notebook' || latest.session !== identity.session ||
                latest.vaultActivation !== identity.vaultActivation || !host.isCurrent(identity) || getBoardRuntime(board) !== runtime ||
                getSessionIdentity(identity.documentId)?.serial !== identity.session) throw new Error('Notebook session is no longer current');
            const sourcePath = latest.path, revision = board.doc.rev;
            const isCurrent = () => {
                const current = host.identity(identity.documentId);
                return !!current && current.kind === 'notebook' && current.path === sourcePath && current.session === identity.session &&
                    current.vaultActivation === identity.vaultActivation && host.isCurrent(identity) &&
                    getSessionIdentity(identity.documentId)?.serial === identity.session && getBoardRuntime(board) === runtime;
            };
            const pin = pinNativeNotebookExport({ runtime, revision, current: isCurrent, onError: options.onError });
            let released = false;
            return {
                sourcePath, isCurrent: () => !released && isCurrent(),
                async run(signal) {
                    if (released || !isCurrent()) throw new DOMException('Notebook export is no longer current', 'AbortError');
                    const bytes = await exportNotebookPdf(pin.snapshot, sourcePath,
                        (input, writerOptions) => options.writer(input, { ...writerOptions, revision: pin.revision }), signal);
                    if (released || !isCurrent()) throw new DOMException('Notebook export is no longer current', 'AbortError');
                    return { paper: { ...pin.snapshot.paper }, bytes };
                },
                release() { if (!released) { released = true; pin.release(); } },
            };
        },
    };
    const path = host.identity(identity.documentId)?.path;
    if (!path) throw new Error('Notebook path is unavailable');
    owner.setSlot(slot, { board, exporter }, value => removeNotebookExporter(value.exporter));
    setNotebookRenderData(path, exporter);
}
