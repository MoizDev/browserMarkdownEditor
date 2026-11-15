import type { ClipboardCache } from '../../utils/clipboardCache';
import type { ClipboardCut } from '../clipboard/copy';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import { deleteNodes } from '../change/commands';
import type { CommandBuilder, Op } from '../change/ops';
import { ClipboardCopy } from '../clipboard/copy';
import { createBoardCopySnapshotNow, type BoardCopySnapshotNowResult } from '../clipboard/runtimeSnapshotNow';
import { createBoardCopySnapshot } from '../clipboard/runtimeSnapshot';
import { buildBoardJson, copyBoardJsonFresh } from '../clipboard/copyJson';
import type { CopySnapshot } from '../clipboard/snapshot';
import { deletionContents } from '../commands/pagesAndSheets';
import type { NativeExportJob } from './nativeExport';
import { hashMedia } from '../media/sha256';
import type { MediaId } from '../model/media';
import type { BoardRuntime } from './runtime';
import type { NodeId } from '../model/ids';
import { exportFileName } from '../export/scope';

const JSON_MEDIA_NOTICE = 'Media are referenced by hash; this JSON is not a portable asset bundle';

const mediaBytes = Symbol('copied board media');
type ResourceSnapshot = CopySnapshot & { readonly [mediaBytes]: { readonly blobs: ReadonlyMap<MediaId, Blob>; readonly fontEpoch: number } }; 

/** Bytes of an actual copy remain available after its source document closes. */
export function readNativeClipboardMedia(snapshot: CopySnapshot, id: MediaId): Blob | null {
    return (snapshot as Partial<ResourceSnapshot>)[mediaBytes]?.blobs.get(id) ?? null;
}

export interface NativeTextClipboardAuthority {
    isCurrent(snapshot: CopySnapshot): boolean;
    /** This proof must perform the real cut preflight before any clipboard write. */
    prepareCut(snapshot: CopySnapshot): ClipboardCut;
}

export interface NativeClipboardCommandsOptions {
    readonly runtime: BoardRuntime;
    readonly token: RenderToken;
    readonly memory: MemoryAllocator;
    readonly cache: ClipboardCache;
    /** Starts synchronously: the producer pins the source before its first await. */
    prepareExport(route: 'copy' | 'context' | 'menu', signal: AbortSignal): Promise<NativeExportJob>;
    duplicate(snapshot: CopySnapshot): Promise<void>;
    current(): boolean;
    /** Captures the originating view, so an async cut cannot borrow a different pane's authority. */
    captureWriteAuthority(): () => boolean;
    notice(message: string): void;
    onError(error: unknown): void;
    copyPng(capture: Promise<Readonly<{ image: Blob; privateImage: Blob }>>): Promise<void>;
    copySvg(capture: Promise<Blob>): Promise<void>;
    download(blob: Blob, filename: string): void;
    /** The open board's name, for the files it exports. */
    boardName(): string;
}

/** Event copy uses the real synchronous native projection, never the previous selection. */
export function createNativeClipboardCommands(options: NativeClipboardCommandsOptions) {
    const { runtime, token } = options, board = runtime.session;
    const active = new Set<AbortController>();
    let disposed = false, selectedProduct: BoardCopySnapshotNowResult | undefined;
    let textAuthority: NativeTextClipboardAuthority | undefined;
    const current = () => !disposed && options.current() && board.owner.documentId === token.documentId && board.owner.session === token.session;
    const guard = () => { if (!current()) throw new DOMException('Board session ended', 'AbortError'); };
    const writable = () => { guard(); if (board.isReadOnly || !options.captureWriteAuthority()()) throw new Error(board.readOnlyReason ?? 'Board view is read-only'); };
    const snapshotCurrent = (snapshot: CopySnapshot) => {
        if (!current() || board.doc.rev !== snapshot.revision || runtime.selection.getSnapshot().sheet !== snapshot.payload.from.sheet) return false;
        if (snapshot.textSelection) return textAuthority?.isCurrent(snapshot) ?? false;
        if (textAuthority) return false;
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
        memory: options.memory,
        readMedia: verifyMedia,
        isCurrent: snapshotCurrent,
        prepareCut(snapshot) {
            writable();
            const authority = options.captureWriteAuthority();
            const assertWrite = () => { writable(); if (!authority()) throw new Error('The original board view is no longer editable'); };
            assertWrite();
            if (snapshot.textSelection) {
                if (!textAuthority || !textAuthority.isCurrent(snapshot)) throw new Error('Text selection changed; cut again');
                const cut = textAuthority.prepareCut(snapshot);
                return { commit() { assertWrite(); cut.commit(); }, release: () => cut.release() };
            }
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
            const proof = board.preflight({ ops, origin: 'host', label: 'Cut' });
            try { receipt.assertCurrent(); }
            catch (error) { proof.release(); throw error; }
            return {
                commit() {
                    assertWrite(); receipt.assertCurrent();
                    if (!snapshotCurrent(snapshot)) throw new Error('Selection changed; nothing was cut');
                    if (proof.ops.length) { const applied = board.apply({ ops: proof.ops, origin: 'host', label: 'Cut' }); applied.release(); }
                    if (result.kept.length) options.notice('Locked content was copied but kept in place.');
                },
                release: () => proof.release(),
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
        if (textAuthority) throw new Error('The text editor owns the current clipboard selection');
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
        cancelBackground();
        if (textAuthority) return;
        selectedProduct = undefined; copy.setSelection(null);
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
    const capture = (extension: 'png' | 'svg', signal: AbortSignal) => {
        guard();
        const prepared = options.prepareExport('copy', signal);
        // ClipboardItem receives this promise immediately, while activation is
        // still live. The frozen producer—not a later live revision—owns pixels.
        const pending = prepared.then(async job => {
            try { return await job[extension](signal); } finally { job.release(); }
        });
        void pending.catch(() => {}); // Permission denial can reject before ClipboardItem consumes its data.
        return pending;
    };
    /** Copy-as-PNG reads the same single producer as capture, with both clipboard items from one frozen job. */
    const capturePng = (signal: AbortSignal) => {
        guard();
        const prepared = options.prepareExport('copy', signal);
        const pending = prepared.then(async job => {
            try { return await job.clipboardPng(signal); } finally { job.release(); }
        });
        void pending.catch(() => {});
        return pending;
    };
    const download = async (extension: 'png' | 'svg', route: 'context' | 'menu', signal: AbortSignal) => {
        guard();
        const job = await options.prepareExport(route, signal);
        try {
            const blob = await job[extension](signal);
            signal.throwIfAborted(); options.download(blob, job.filename(extension));
        } finally { job.release(); }
    };
    // One export or copy of this view at a time: a new one supersedes the one still running, so the older capture stops
    // instead of finishing into a clipboard or download the user has already replaced.
    let latest: AbortController | undefined;
    /** File export of the records: the same chunked producer as copy, saved under the board's name. A selection on a
     * context route, otherwise the whole sheet. */
    const exportJson = async (route: 'context' | 'menu', signal: AbortSignal) => {
        guard();
        const state = runtime.selection.getSnapshot(), roots = route === 'context' ? [...state.selected] : [];
        const selection = roots.length ? roots : [...(board.doc.bySheet.get(state.sheet) ?? [])];
        let media = 0;
        const built = await buildBoardJson({ runtime, memory: options.memory, signal, current, capture: async captureSignal => {
            const snapshot = await createBoardCopySnapshot({ runtime, memory: options.memory, current, selection, signal: captureSignal });
            media = snapshot.media.length;
            return snapshot;
        } });
        try {
            signal.throwIfAborted();
            const sheet = board.doc.sheetOrder.length > 1 ? board.doc.sheets.get(state.sheet)?.name ?? null : null;
            options.download(built.blob, exportFileName(options.boardName(), sheet, roots.length ? 'selection' : 'sheet', 'json', new Date()));
            if (media) options.notice(JSON_MEDIA_NOTICE);
        } finally { built.release(); }
    };
    const withController = async (work: (signal: AbortSignal) => Promise<void>) => {
        latest?.abort(new DOMException('Export superseded', 'AbortError'));
        const owned = new AbortController(); active.add(owned); latest = owned;
        try { await work(owned.signal); }
        finally { active.delete(owned); if (latest === owned) latest = undefined; owned.abort(); }
    };
    return {
        /** Borrowed by inline text clipboard adapters; this document remains its owner. */
        clipboardCopy: copy,
        bindTextAuthority(authority: NativeTextClipboardAuthority) {
            guard();
            cancelBackground(); selectedProduct = undefined; copy.setSelection(null);
            textAuthority = authority;
            return () => {
                if (textAuthority !== authority) return;
                textAuthority = undefined;
                if (!disposed) prepareSettledSelection();
            };
        },
        matchClipboard: (encoded: string, plain: string) => copy.match(encoded, plain),
        copy: () => run(async () => { prepare(); await copy.copyMenu(); }),
        cut: () => run(async () => { writable(); prepare(true); await copy.copyMenu(true); }),
        duplicate: () => run(async () => { writable(); prepare(); await copy.duplicate(); }),
        copyEvent(event: ClipboardEvent, cut = false): boolean {
            try { if (cut) writable(); prepare(cut); return copy.copyEvent(event, cut); }
            catch (error) { options.onError(error); return false; }
        },
        copyAsPng: () => run(() => withController(signal => options.copyPng(capturePng(signal)))),
        copyAsSvg: () => run(() => withController(signal => options.copySvg(capture('svg', signal)))),
        copyAsJson: () => run(async () => {
            guard();
            const state = runtime.selection.getSnapshot();
            const selection = state.selected.length ? state.selected : [...(board.doc.bySheet.get(state.sheet) ?? [])];
            // The JSON is built inside its own job, chunk by chunk under the memory governor, and the write takes its promise
            // while the click is live: the same in-job capture the record copy uses.
            let media = 0;
            await copyBoardJsonFresh({ runtime, memory: options.memory, current, capture: async signal => {
                const snapshot = await createBoardCopySnapshot({ runtime, memory: options.memory, current, selection, signal });
                media = snapshot.media.length;
                return snapshot;
            } });
            if (media) options.notice(JSON_MEDIA_NOTICE);
        }),
        exportJson: (route: 'context' | 'menu' = 'menu') => run(() => withController(signal => exportJson(route, signal))),
        exportPng: (route: 'context' | 'menu' = 'menu') => run(() => withController(signal => download('png', route, signal))),
        exportSvg: (route: 'context' | 'menu' = 'menu') => run(() => withController(signal => download('svg', route, signal))),
        dispose() { if (!disposed) { disposed = true; cancelBackground(); stopSelection(); stopChanges(); stopGeometry();
            // Captured read-only jobs own their source leases. Retiring the
            // document stops new work, not a clipboard write already in flight.
            selectedProduct = undefined; textAuthority = undefined; copy.dispose(); } },
    };
}
