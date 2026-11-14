import type { ClipboardCache } from '../../utils/clipboardCache';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import { deleteNodes } from '../change/commands';
import type { CommandBuilder, Op } from '../change/ops';
import { ClipboardCopy } from '../clipboard/copy';
import { prepareInlineMedia } from '../clipboard/encode';
import { createBoardCopySnapshotNow, type BoardCopySnapshotNowResult } from '../clipboard/runtimeSnapshotNow';
import { createBoardCopySnapshot } from '../clipboard/runtimeSnapshot';
import type { CopySnapshot } from '../clipboard/snapshot';
import { deletionContents } from '../commands/pagesAndSheets';
import type { PinExportSnapshot } from '../export/snapshot';
import { exportSnapshotPng, exportSnapshotSvg, type SnapshotExportBounds } from '../export/snapshotExport';
import { hashMedia } from '../media/sha256';
import type { MediaId } from '../model/media';
import type { BoardRuntime } from './runtime';

const mediaBytes = Symbol('copied board media');
type ResourceSnapshot = CopySnapshot & { readonly [mediaBytes]: { readonly blobs: ReadonlyMap<MediaId, Blob>; readonly fontEpoch: number } }; 

/** Bytes of an actual copy remain available after its source document closes. */
export function readNativeClipboardMedia(snapshot: CopySnapshot, id: MediaId): Blob | null {
    return (snapshot as Partial<ResourceSnapshot>)[mediaBytes]?.blobs.get(id) ?? null;
}

export interface NativeClipboardCommandsOptions {
    readonly runtime: BoardRuntime;
    readonly token: RenderToken;
    readonly memory: MemoryAllocator;
    readonly cache: ClipboardCache;
    exportPin(route: 'copy' | 'menu'): PinExportSnapshot;
    exportBounds(route: 'copy' | 'menu'): SnapshotExportBounds;
    exportFilename(extension: 'png' | 'svg'): string;
    duplicate(snapshot: CopySnapshot): Promise<void>;
    current(): boolean;
    notice(message: string): void;
    onError(error: unknown): void;
    copyPng(capture: Promise<Blob>): Promise<void>;
    copySvg(capture: Promise<Blob>): Promise<void>;
    download(blob: Blob, filename: string): void;
}

/** Event copy uses the real synchronous native projection, never the previous selection. */
export function createNativeClipboardCommands(options: NativeClipboardCommandsOptions) {
    const { runtime, token } = options, board = runtime.session;
    const active = new Set<AbortController>();
    let disposed = false, selectedProduct: BoardCopySnapshotNowResult | undefined;
    const current = () => !disposed && options.current() && board.owner.documentId === token.documentId && board.owner.session === token.session;
    const guard = () => { if (!current()) throw new DOMException('Board session ended', 'AbortError'); };
    const writable = () => { guard(); if (board.isReadOnly) throw new Error(board.readOnlyReason ?? 'Board is read-only'); };
    const snapshotCurrent = (snapshot: CopySnapshot) => {
        if (!current() || board.doc.rev !== snapshot.revision || runtime.selection.getSnapshot().sheet !== snapshot.payload.from.sheet) return false;
        const selected = runtime.selection.getSnapshot().selected;
        return selected.length === snapshot.selected.length && selected.every(id => snapshot.selected.includes(id));
    };
    const verifyMedia = async (snapshot: CopySnapshot, id: MediaId, signal: AbortSignal) => {
        signal.throwIfAborted();
        const blob = readNativeClipboardMedia(snapshot, id);
        if (blob && await hashMedia(blob, signal) !== id) throw new Error('Clipboard media hash mismatch');
        signal.throwIfAborted();
        return blob;
    };
    const copy = new ClipboardCopy({
        readMedia: verifyMedia,
        isCurrent: snapshotCurrent,
        prepareCut(snapshot) {
            writable();
            const product = selectedProduct, receipt = product?.cutReceipt;
            if (product?.snapshot !== snapshot || !receipt) throw product?.cutFailure ?? new Error('Cut geometry is unavailable');
            receipt.assertCurrent();
            if (!snapshotCurrent(snapshot) || snapshot.skippedOpaque.length || receipt.doc !== board.doc) throw new Error('Selection changed or contains unsupported content');
            deletionContents(board.doc, snapshot.roots);
            // A real TxBuilder mutates while staging. Collect the canonical command
            // first: no live transaction may span an asynchronous clipboard write.
            const ops: Op[] = [], marks = new Map<number, number>();
            let nextMark = 0, closed = false;
            const checkPlan = () => { if (closed) throw new Error('Cut plan is closed'); receipt.assertCurrent(); };
            const draft: CommandBuilder = {
                push(op) { checkPlan(); ops.push(op); },
                savepoint() { checkPlan(); const id = ++nextMark; marks.set(id, ops.length); return id; },
                rollbackTo(id) { checkPlan(); const length = marks.get(id); if (length === undefined) throw new Error('Invalid cut savepoint'); ops.length = length; },
                abort() { closed = true; ops.length = 0; marks.clear(); },
            };
            const result = deleteNodes(board.doc, draft, snapshot.roots, receipt.geometry);
            receipt.assertCurrent();
            return () => {
                writable(); receipt.assertCurrent();
                if (!snapshotCurrent(snapshot)) throw new Error('Selection changed; nothing was cut');
                if (ops.length) {
                    const builder = board.begin('host', 'Cut');
                    try { for (const op of ops) builder.push(op); const applied = builder.commit(); applied.release(); }
                    catch (error) { try { builder.abort(); } catch { /* Preserve the original commit failure. */ } throw error; }
                }
                if (result.kept.length) options.notice('Locked content was copied but kept in place.');
            };
        },
        duplicate: snapshot => options.duplicate(snapshot),
        notice: message => options.notice(message),
    }, options.cache);
    const ownMedia = (product: BoardCopySnapshotNowResult): BoardCopySnapshotNowResult => {
        try {
            const blobs = new Map<MediaId, Blob>();
            for (const entry of product.snapshot.media) {
                const blob = runtime.media.get(entry.id);
                if (blob) blobs.set(entry.id, blob.slice(0, blob.size, blob.type));
            }
            const snapshot: ResourceSnapshot = { ...product.snapshot, [mediaBytes]: { blobs, fontEpoch: runtime.render.text.fonts.epoch } };
            return { ...product, snapshot };
        } catch (error) { for (const lease of product.snapshot.leases) lease.release(); throw error; }
    };
    const selectedNow = () => {
        guard();
        return ownMedia(createBoardCopySnapshotNow({ runtime, memory: options.memory, current }));
    };
    const publishSelection = (product: BoardCopySnapshotNowResult) => {
        selectedProduct = undefined;
        copy.setSelection(product.snapshot);
        selectedProduct = product;
    };
    const prepare = (cut = false) => {
        const snapshot = selectedProduct?.snapshot as ResourceSnapshot | undefined;
        if (!cut && snapshot && snapshotCurrent(snapshot) && snapshot[mediaBytes].fontEpoch === runtime.render.text.fonts.epoch) return;
        publishSelection(selectedNow());
    };
    let idle: number | undefined, background: AbortController | undefined;
    const cancelBackground = () => {
        if (idle !== undefined) cancelIdleCallback(idle);
        idle = undefined; background?.abort(); background = undefined;
    };
    const prepareSettledSelection = () => {
        cancelBackground(); selectedProduct = undefined; copy.setSelection(null);
        if (!current() || !runtime.selection.getSnapshot().selected.length) return;
        const state = runtime.selection.getSnapshot(), revision = board.doc.rev, epoch = runtime.render.text.fonts.epoch;
        idle = requestIdleCallback(() => {
            idle = undefined;
            const controller = new AbortController(); background = controller;
            const valid = () => current() && !controller.signal.aborted && board.doc.rev === revision &&
                runtime.selection.getSnapshot() === state && runtime.render.text.fonts.epoch === epoch;
            void createBoardCopySnapshot({ runtime, memory: options.memory, current: valid, signal: controller.signal }).then(snapshot => {
                if (!valid()) { for (const lease of snapshot.leases) lease.release(); return; }
                publishSelection(ownMedia({ snapshot, cutReceipt: null }));
            }).catch(() => {
                // Idle preparation is optional; the event's synchronous producer
                // remains authoritative and reports an actual requested-copy failure.
            }).finally(() => { if (background === controller) background = undefined; });
        }, { timeout: 250 });
    };
    const stopSelection = runtime.selection.subscribe(prepareSettledSelection), stopChanges = board.onChange(prepareSettledSelection);
    const stopGeometry = runtime.render.subscribeInvalidation(prepareSettledSelection);
    prepareSettledSelection();
    const run = async (work: () => Promise<void>) => {
        try { await work(); } catch (error) { options.onError(error); }
    };
    const capture = (route: 'copy' | 'menu') => {
        guard();
        const revision = board.doc.rev, source = options.exportPin(route), bounds = options.exportBounds(route);
        const pin: PinExportSnapshot = () => {
            guard();
            const snapshot = source(), actual = snapshot.token;
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
        const owned = new AbortController(); active.add(owned);
        try { await work(owned.signal); } finally { active.delete(owned); owned.abort(); }
    };
    return {
        matchClipboard: (encoded: string, plain: string) => copy.match(encoded, plain),
        copy: () => run(async () => { prepare(); await copy.copyMenu(); }),
        cut: () => run(async () => { writable(); prepare(true); await copy.copyMenu(true); }),
        duplicate: () => run(async () => { writable(); prepare(); await copy.duplicate(); }),
        copyEvent(event: ClipboardEvent, cut = false): boolean {
            try { if (cut) writable(); prepare(cut); return copy.copyEvent(event, cut); }
            catch (error) { options.onError(error); return false; }
        },
        copyAsPng: () => run(() => withController(signal => options.copyPng(png('copy', signal)))),
        copyAsSvg: () => run(() => withController(signal => options.copySvg(svg('copy', signal)))),
        copyAsJson: () => run(() => withController(async signal => {
            const snapshot = selectedNow().snapshot, sizes = new Map(snapshot.media.map(entry => [entry.id, entry.bytes]));
            const payload = (async () => {
                try {
                    const inline = await prepareInlineMedia(snapshot, async (id, mediaSignal) => {
                        const blob = await verifyMedia(snapshot, id, mediaSignal);
                        if (blob && blob.size !== sizes.get(id)) throw new Error('Clipboard media size mismatch');
                        return blob;
                    }, signal);
                    if (!snapshotCurrent(snapshot)) throw new Error('Selection changed during copy');
                    const complete = snapshot.media.every(entry => inline.has(entry.id)), media: Record<string, string> = Object.create(null);
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
        dispose() { if (!disposed) { disposed = true; cancelBackground(); stopSelection(); stopChanges(); stopGeometry();
            selectedProduct = undefined; for (const owned of active) owned.abort(); active.clear(); copy.dispose(); } },
    };
}
