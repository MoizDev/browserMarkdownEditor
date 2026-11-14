import type { RenderToken } from '../../platform/render/types';
import { deleteNodes } from '../change/commands';
import type { ChangeGeometry } from '../change/coordinates';
import { ClipboardCopy } from '../clipboard/copy';
import { prepareInlineMedia } from '../clipboard/encode';
import { snapshotSelection, type CopySnapshot, type CopySnapshotHost } from '../clipboard/snapshot';
import { deletionContents } from '../commands/pagesAndSheets';
import type { PinExportSnapshot } from '../export/snapshot';
import { exportSnapshotPng, exportSnapshotSvg, type SnapshotExportBounds } from '../export/snapshotExport';
import type { BoardRuntime } from './runtime';
import { hashMedia } from '../media/sha256';
import type { MediaId } from '../model/media';

export interface NativeClipboardCommandsOptions {
    readonly runtime: BoardRuntime;
    readonly token: RenderToken;
    readonly geometry: ChangeGeometry;
    snapshotHost(): CopySnapshotHost;
    exportPin(route: 'copy' | 'menu'): PinExportSnapshot;
    exportBounds(route: 'copy' | 'menu'): SnapshotExportBounds;
    exportFilename(extension: 'png' | 'svg'): string;
    readMedia(id: MediaId, signal: AbortSignal): Promise<Blob | null>;
    duplicate(snapshot: CopySnapshot): Promise<void>;
    current(): boolean;
    notice(message: string): void;
    onError(error: unknown): void;
    copyPng(capture: Promise<Blob>): Promise<void>;
    copySvg(capture: Promise<Blob>): Promise<void>;
    download(blob: Blob, filename: string): void;
}

/** Browser delivery borrows exact session snapshots; neither copy nor export owns a board. */
export function createNativeClipboardCommands(options: NativeClipboardCommandsOptions) {
    const { runtime, token } = options, board = runtime.session;
    const active = new Set<AbortController>();
    let disposed = false;
    const current = () => !disposed && options.current() && board.owner.documentId === token.documentId && board.owner.session === token.session;
    const guard = () => { if (!current()) throw new DOMException('Board session ended', 'AbortError'); };
    const writable = () => { guard(); if (board.isReadOnly) throw new Error(board.readOnlyReason ?? 'Board is read-only'); };
    const snapshotCurrent = (snapshot: CopySnapshot) => {
        if (!current() || board.doc.rev !== snapshot.revision || runtime.selection.getSnapshot().sheet !== snapshot.payload.from.sheet) return false;
        const selected = runtime.selection.getSnapshot().selected;
        return selected.length === snapshot.selected.length && selected.every(id => snapshot.selected.includes(id));
    };
    const verifyMedia = async (id: MediaId, signal: AbortSignal) => {
        guard(); signal.throwIfAborted();
        const blob = await options.readMedia(id, signal);
        guard(); signal.throwIfAborted();
        if (blob && await hashMedia(blob, signal) !== id) throw new Error('Clipboard media hash mismatch');
        guard(); signal.throwIfAborted();
        return blob;
    };
    const copy = new ClipboardCopy({
        readMedia: verifyMedia,
        isCurrent: snapshotCurrent,
        prepareCut(snapshot) {
            writable();
            if (!snapshotCurrent(snapshot) || snapshot.skippedOpaque.length) throw new Error('Selection changed or contains unsupported content');
            deletionContents(board.doc, snapshot.roots);
            return () => {
                writable();
                if (!snapshotCurrent(snapshot)) throw new Error('Selection changed; nothing was cut');
                const builder = board.begin('host', 'Cut');
                try {
                    deleteNodes(board.doc, builder, snapshot.roots, options.geometry);
                    const applied = builder.commit();
                    applied.release();
                } catch (error) { try { builder.abort(); } catch { /* The failed builder may already be closed. */ } throw error; }
            };
        },
        duplicate: snapshot => options.duplicate(snapshot),
        notice: message => options.notice(message),
    });
    const selected = () => {
        guard();
        const host = options.snapshotHost(), selection = runtime.selection.getSnapshot();
        if (host.doc !== board.doc || host.sheet !== selection.sheet) throw new Error('Clipboard snapshot does not belong to the current board');
        return snapshotSelection(host, selection.selected);
    };
    const prepare = () => { copy.setSelection(selected()); };
    const run = async (work: () => Promise<void>) => {
        try { await work(); } catch (error) { options.onError(error); }
    };
    const controller = () => { const next = new AbortController(); active.add(next); return next; };
    const capture = (route: 'copy' | 'menu') => {
        guard();
        const revision = board.doc.rev, source = options.exportPin(route), bounds = options.exportBounds(route);
        const pin: PinExportSnapshot = () => {
            guard();
            const snapshot = source();
            const actual = snapshot.token;
            if (snapshot.revision !== revision || actual.documentId !== token.documentId || actual.session !== token.session
                || actual.vaultEpoch !== token.vaultEpoch || actual.bytesGeneration !== token.bytesGeneration) {
                snapshot.release(); throw new Error('Export snapshot does not match the current board');
            }
            return snapshot;
        };
        const validate = () => { guard(); if (board.doc.rev !== revision) throw new Error('Board changed during export'); };
        return { bounds, pin, validate };
    };
    const png = (route: 'copy' | 'menu', signal: AbortSignal) => {
        const { bounds, pin, validate } = capture(route);
        return exportSnapshotPng(pin, bounds, signal, { clipboard: route === 'copy' }).then(blob => { validate(); return blob; });
    };
    const svg = (route: 'copy' | 'menu', signal: AbortSignal) => {
        const { bounds, pin, validate } = capture(route);
        return exportSnapshotSvg(pin, bounds, signal).then(blob => { validate(); return blob; });
    };
    const withController = async (work: (signal: AbortSignal) => Promise<void>) => {
        const owned = controller();
        try { await work(owned.signal); } finally { active.delete(owned); owned.abort(); }
    };
    return {
        copy: () => run(async () => { prepare(); await copy.copyMenu(); }),
        cut: () => run(async () => { writable(); prepare(); await copy.copyMenu(true); }),
        copyEvent(event: ClipboardEvent, cut = false): boolean {
            try { if (cut) writable(); prepare(); return copy.copyEvent(event, cut); }
            catch (error) { options.onError(error); return false; }
        },
        copyAsPng: () => run(() => withController(signal => options.copyPng(png('copy', signal)))),
        copyAsSvg: () => run(() => withController(signal => options.copySvg(svg('copy', signal)))),
        copyAsJson: () => run(() => withController(async signal => {
            const snapshot = selected();
            const sizes = new Map(snapshot.media.map(entry => [entry.id, entry.bytes]));
            const payload = (async () => {
                try {
                    const inline = await prepareInlineMedia(snapshot, async (id, mediaSignal) => {
                        const blob = await verifyMedia(id, mediaSignal);
                        if (blob && blob.size !== sizes.get(id)) throw new Error('Clipboard media size mismatch');
                        return blob;
                    }, signal);
                    if (!snapshotCurrent(snapshot)) throw new Error('Selection changed during copy');
                    const complete = snapshot.media.every(entry => inline.has(entry.id));
                    const media: Record<string, string> = Object.create(null);
                    if (complete) for (const [id, bytes] of inline) media[id] = bytes;
                    else options.notice('Media are referenced by hash; this JSON is not a portable asset bundle');
                    return new Blob([JSON.stringify({ ...snapshot.payload, media })], { type: 'text/plain' });
                } finally { for (const lease of snapshot.leases) lease.release(); }
            })();
            try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': payload })]); }
            finally { void payload.catch(() => {}); }
        })),
        exportPng: () => run(() => withController(async signal => { const name = options.exportFilename('png'); const blob = await png('menu', signal); guard(); options.download(blob, name); })),
        exportSvg: () => run(() => withController(async signal => { const name = options.exportFilename('svg'); const blob = await svg('menu', signal); guard(); options.download(blob, name); })),
        dispose() { if (!disposed) { disposed = true; for (const owned of active) owned.abort(); active.clear(); copy.dispose(); } },
    };
}
