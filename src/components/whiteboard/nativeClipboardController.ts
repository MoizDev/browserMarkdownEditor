import type { CameraController } from '../../platform/render/camera';
import { surfaceToWorld, worldToSurface } from '../../platform/render/camera';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { pasteBoardClipboardInJob } from '../../whiteboard/clipboard/paste';
import { acquireCopiedBoardClipboard, type BoardClipboardAcquisition } from '../../whiteboard/host/clipboardAcquisition';
import { createBoardClipboardPasteHost } from '../../whiteboard/host/clipboardPasteHost';
import { BOARD_Z_MAX } from '../../utils/boardZMax';
import { readNativeClipboardMedia } from '../../whiteboard/host/clipboardCommands';
import { classifyClipboardJson } from '../../whiteboard/host/clipboardJsonKind';
import { createClipboardHtmlFrameHost } from '../../whiteboard/clipboard/htmlFrameHost';
import { insertNativeClipboard } from '../../whiteboard/clipboard/insertNative';
import { planBoardClipboardPlacement } from '../../whiteboard/clipboard/placement';
import { prepareBoardClipboardMediaInJob } from '../../whiteboard/clipboard/prepareMedia';
import { acceptsBoardDrag, captureTransfer } from '../../whiteboard/clipboard/transfer';
import type { CachedClipboard, ClipboardCachePin } from '../../whiteboard/clipboard/copy';
import type { CopySnapshot } from '../../whiteboard/clipboard/snapshot';
import type { ClipboardInput, ClipboardIntent, ClipboardPoint, ClipboardTarget } from '../../whiteboard/clipboard/types';
import type { createBoardMediaIngestor } from '../../whiteboard/host/mediaIngest';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { MediaEntry, MediaId } from '../../whiteboard/model/media';
import type { StoreMedia } from '../../whiteboard/media/storage.types';
import type { BoardJobIdentity } from '../../whiteboard/workers/protocol';

export interface NativeClipboardControllerOptions {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly memory: MemoryAllocator;
    readonly ingestor: ReturnType<typeof createBoardMediaIngestor>;
    readonly pasteAtCursor: () => boolean;
    /** Last pointer in world coordinates, or null when it has not entered this view. */
    readonly pointer: () => ClipboardPoint | null;
    readonly surfacePoint: (clientX: number, clientY: number) => ClipboardPoint;
    readonly editingText: () => boolean;
    readonly canWriteView: () => boolean;
    readonly finishGesture: () => void;
    readonly pinClipboard: () => ClipboardCachePin | null;
    readonly readMedia: (entry: MediaEntry, signal: AbortSignal) => Promise<Blob | null>;
    readonly storeMedia: StoreMedia;
    readonly notice: (message: string) => void;
    readonly onError: (error: unknown) => void;
}

/** Paste/drop own one serial session job; unsupported semantic converters remain explicit frontiers. */
export function createNativeClipboardController(options: NativeClipboardControllerOptions) {
    const { runtime, identity, host } = options, session = runtime.session, doc = session.doc;
    let disposed = false, pending = 0, retired: (() => void) | undefined;
    const lifetime = new AbortController(), jobs = new Set<AbortController>();
    const releaseRetired = () => { if (retired && pending === 0) { const done = retired; retired = undefined; disposed = true; lifetime.abort(); done(); } };
    const current = () => {
        const admitted = host.identity(identity.documentId);
        return !disposed && host.isCurrent(identity) && !!admitted && admitted.documentId === identity.documentId
            && admitted.session === identity.session && admitted.vaultActivation === identity.vaultActivation
            && admitted.bytesGeneration === identity.bytesGeneration && admitted.kind === identity.kind
            && runtime.session === session && session.doc === doc
            && session.owner.documentId === identity.documentId && session.owner.session === identity.session;
    };
    const targetNow = (pointer?: ClipboardPoint | null) => {
        if (!current() || !options.canWriteView() || session.isReadOnly) throw new Error(session.readOnlyReason ?? 'Board is not editable');
        options.finishGesture();
        if (!current() || !options.canWriteView() || session.isReadOnly || session.isGestureActive) throw new Error('Board is not ready for paste');
        const selection = runtime.selection.getSnapshot(), camera = options.camera.camera, viewport = options.camera.viewport;
        if (!Number.isFinite(camera.z) || camera.z <= 0 || viewport.width <= 0 || viewport.height <= 0) throw new Error('Board viewport is unavailable');
        const chosen = selection.selected.length === 1 ? doc.nodes.get(selection.selected[0]) : undefined;
        const location = pointer === undefined ? options.pointer() : pointer;
        const target: ClipboardTarget = Object.freeze({ session: `${identity.documentId}:${identity.session}`,
            vaultEpoch: identity.vaultActivation, generation: identity.bytesGeneration, sheet: selection.sheet,
            viewport: Object.freeze({ x: camera.x, y: camera.y, w: viewport.width / camera.z, h: viewport.height / camera.z }),
            pointer: location ? Object.freeze({ ...location }) : null, selectedFrame: chosen?.kind === 'frame' ? chosen.id : null,
            pasteAtCursor: options.pasteAtCursor() });
        return { target, zoom: camera.z };
    };
    // R-21: a paste never changes zoom. Only when the placed centre lies outside the view does the camera pan, at the same
    // zoom, to centre it; a centre already in view needs no pan. Measured against the camera now, since decoding is async.
    const bringIntoView = (point: ClipboardPoint) => {
        const camera = options.camera.camera, viewport = options.camera.viewport;
        if (viewport.width <= 0 || viewport.height <= 0) return;
        const surface = worldToSurface(point, camera);
        if (surface.x >= 0 && surface.y >= 0 && surface.x <= viewport.width && surface.y <= viewport.height) return;
        options.camera.setCamera({ x: point.x - viewport.width / (2 * camera.z), y: point.y - viewport.height / (2 * camera.z), z: camera.z });
    };
    const targetCurrent = (target: Readonly<ClipboardTarget>) => current() && options.canWriteView() && !session.isReadOnly
        && target.session === `${identity.documentId}:${identity.session}` && target.vaultEpoch === identity.vaultActivation
        && target.generation === identity.bytesGeneration && runtime.selection.getSnapshot().sheet === target.sheet;
    const execute = (input: Promise<ClipboardInput> | null, captured: ReturnType<typeof targetNow>, intent: ClipboardIntent,
        duplicate?: { snapshot: CopySnapshot; media: ReadonlyMap<MediaId, Blob> },
        imageRead?: Promise<ClipboardInput | null>, externalSignal?: AbortSignal, capturedPin?: ClipboardCachePin | null) => {
        const pin = capturedPin === undefined ? (duplicate ? null : options.pinClipboard()) : capturedPin;
        const controller = new AbortController();
        jobs.add(controller);
        const stop = runtime.selection.subscribe(() => {
            if (runtime.selection.getSnapshot().sheet !== captured.target.sheet) controller.abort();
        });
        const signal = AbortSignal.any([lifetime.signal, controller.signal, ...externalSignal ? [externalSignal] : []]);
        pending++;
        const work = runtime.jobs.run(async context => {
            const { target, zoom } = captured, revision = doc.rev;
            const check = () => { context.assertCurrent(); if (!targetCurrent(target) || doc.rev !== revision) throw new DOMException('Clipboard target changed', 'AbortError'); };
            check();
            const workerIdentity: BoardJobIdentity = { session: context.job.session, epoch: context.job.vaultEpoch, revision };
            const workerCurrent = (job: BoardJobIdentity) => job.session === workerIdentity.session && job.epoch === workerIdentity.epoch
                && job.revision === revision && runtime.jobs.isCurrent(context.job) && targetCurrent(target) && doc.rev === revision;
            const insertAcquisition = async (acquired: BoardClipboardAcquisition, copied?: { snapshot: CopySnapshot; readMedia?: CachedClipboard['readMedia'] }) => {
                let staged: Awaited<ReturnType<typeof prepareBoardClipboardMediaInJob>> | undefined, transferred = false;
                try {
                    check();
                    staged = await prepareBoardClipboardMediaInJob({ runtime, acquisition: acquired, memory: options.memory,
                        current: () => targetCurrent(target) && doc.rev === revision, signal: context.signal,
                        readBlob: async (entry, readSignal) => (copied?.readMedia ? await copied.readMedia(entry.id, readSignal)
                            : copied ? readNativeClipboardMedia(copied.snapshot, entry.id) : null) ?? options.readMedia(entry, readSignal),
                        storeMedia: options.storeMedia }, context);
                    check();
                    const placement = planBoardClipboardPlacement({ receivingBoardId: identity.documentId, target, source: acquired.payload,
                        containsFrame: [...acquired.load.doc.nodes.values()].some(node => node.kind === 'frame'), doc, cameraZoom: zoom, intent });
                    transferred = true;
                    await insertNativeClipboard({ runtime, acquisition: acquired, media: staged, placement, target,
                        receivingBoardId: identity.documentId, external: false, current: targetCurrent, signal: context.signal });
                    if (current()) bringIntoView(placement.worldCentre);
                } finally { if (!transferred) { staged?.release(); acquired.dispose(); } }
            };
            if (duplicate) {
                const acquired = await acquireCopiedBoardClipboard(duplicate.snapshot, { identity: workerIdentity, isCurrent: workerCurrent,
                    signal: context.signal, media: duplicate.media });
                await insertAcquisition(acquired, { snapshot: duplicate.snapshot });
                return;
            }
            if (!input) throw new Error('Clipboard input is unavailable');
            const capturedInput = await input; check();
            // Image files on the clipboard may carry a private PNG that only the image read can see. Supplying
            // it as the input's privatePng makes classification choose the private-PNG path before files.
            const privatePng = imageRead ? (await imageRead)?.privatePng ?? null : null; check();
            const pasteInput: ClipboardInput = privatePng && capturedInput.files.length && !capturedInput.privatePng
                ? { ...capturedInput, privatePng } : capturedInput;
            const html = createClipboardHtmlFrameHost({ memory: options.memory, identity: workerIdentity, isCurrent: workerCurrent });
            const pasteHost = createBoardClipboardPasteHost({ runtime, memory: options.memory, token: runtime.paintToken, zMax: BOARD_Z_MAX,
                classifier: { appOrigin: location.origin, markers: html.markers, jsonKind: (text, innerSignal) => classifyClipboardJson({
                    bytes: new Blob([text]), identity: workerIdentity, memory: options.memory, isCurrent: workerCurrent, signal: innerSignal }) },
                html, ingestor: options.ingestor, receivingBoardId: identity.documentId, cameraZoom: zoom,
                embedEnvironment: { appOrigin: location.origin }, embedManifest: host.embeds.manifest,
                current: targetCurrent, readBlob: options.readMedia, storeMedia: options.storeMedia,
                notice: options.notice, noticeRefused: items => options.notice(items.map(item => `${item.name}: ${item.reason}`).join('; ')),
                isCurrent: workerCurrent });
            const placed = await pasteBoardClipboardInJob(pasteHost, pasteInput, target, intent, context, pin ?? undefined);
            // A paste that places nothing and says nothing is indistinguishable from a broken one: name it.
            if (!placed.length && !duplicate) options.notice('Nothing was pasted from the clipboard.');
        }, { signal, deadlineMs: 120_000 });
        return work.finally(() => {
            try { stop(); } finally {
                jobs.delete(controller); controller.abort();
                try { pin?.release(); } finally { pending--; releaseRetired(); }
            }
        });
    };
    const report = (fn: () => void) => { try { fn(); } catch (error) { options.onError(error); } };
    // An interrupted paste (its target changed, or it was cancelled) used to end silently: say so, and say to paste again.
    const pasteFailure = (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') options.notice('Nothing was pasted: the paste was interrupted. Paste again.');
        else options.onError(error);
    };
    const pasteEvent = (event: ClipboardEvent) => {
        if (options.editingText() || !event.clipboardData) return false;
        return (() => { try { const captured = targetNow(), input = captureTransfer(event.clipboardData!); event.preventDefault();
            const imageRead = input.files.some(file => file.blob.type.startsWith('image/')) ? readClipboard().catch(() => null) : undefined;
            void execute(Promise.resolve(input), captured, 'paste', undefined, imageRead).catch(pasteFailure); return true; }
            catch (error) { options.onError(error); return false; } })();
    };
    const readClipboard = async (): Promise<ClipboardInput> => {
        const clipboard = navigator.clipboard as Clipboard & { read(options: { unsanitized: string[] }): Promise<ClipboardItems> };
        const items = await clipboard.read({ unsanitized: ['text/html'] });
        let html: string | null = null, text: string | null = null, svg: string | null = null, privatePng: Blob | null = null;
        const files: ClipboardInput['files'][number][] = [];
        for (const item of items) for (const type of item.types) {
            const blob = await item.getType(type);
            if (type === 'text/html' && html === null) html = await blob.text();
            else if (type === 'text/plain' && text === null) text = await blob.text();
            else if (type === 'image/svg+xml' && svg === null) svg = await blob.text();
            else if (type === 'web image/x-board+png' && !privatePng) privatePng = blob;
            else if (type.startsWith('image/') || type.startsWith('video/')) files.push({ blob, name: `clipboard.${type.split('/')[1]}`, directory: false });
        }
        return { html, text, svg, uriList: null, files, privatePng };
    };
    const capturePasteTarget = (intent: ClipboardIntent, borrowedPin?: ClipboardCachePin | null) => {
        const target = targetNow(), revision = doc.rev, selection = runtime.selection.getSnapshot();
        let pin = borrowedPin === undefined ? options.pinClipboard() : borrowedPin, consumed = false;
        const cachePin = pin;
        return {
            cachePin,
            run(input: ClipboardInput, signal?: AbortSignal): Promise<void> {
                if (consumed) return Promise.reject(new Error('Clipboard capture was already consumed'));
                consumed = true;
                if (!current() || doc.rev !== revision || runtime.selection.getSnapshot() !== selection) {
                    pin?.release(); pin = null;
                    return Promise.reject(new DOMException('Clipboard target changed', 'AbortError'));
                }
                const transfer = pin; pin = null;
                try { return execute(Promise.resolve(input), target, intent, undefined, undefined, signal, transfer); }
                catch (error) { transfer?.release(); throw error; }
            },
            release() { if (!consumed) { consumed = true; pin?.release(); pin = null; } },
        };
    };
    return {
        pasteEvent,
        readClipboard,
        captureInsertionTarget() {
            const captured = targetNow(), revision = doc.rev, selection = runtime.selection.getSnapshot();
            return { ...captured, current: () => targetCurrent(captured.target) && doc.rev === revision
                && runtime.selection.getSnapshot() === selection };
        },
        capturePasteTarget,
        paste(intent: 'paste' | 'paste-inverted' | 'paste-plain' | 'paste-plain-inverted' = 'paste') {
            if (options.editingText()) return;
            report(() => { const target = targetNow(); const read = readClipboard(); void read.catch(() => {}); void execute(read, target, intent).catch(pasteFailure); });
        },
        keydown(event: KeyboardEvent) {
            if (options.editingText() || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'v' || (!event.altKey && !event.shiftKey)) return false;
            event.preventDefault();
            const intent = event.shiftKey ? event.altKey ? 'paste-plain-inverted' : 'paste-plain' : 'paste-inverted';
            report(() => { const target = targetNow(); const read = readClipboard(); void read.catch(() => {}); void execute(read, target, intent).catch(pasteFailure); });
            return true;
        },
        duplicate(snapshot: CopySnapshot): Promise<void> {
            const target = targetNow(), media = new Map<MediaId, Blob>();
            for (const entry of snapshot.media) {
                const blob = readNativeClipboardMedia(snapshot, entry.id);
                if (blob) media.set(entry.id, blob);
            }
            return execute(null, target, 'duplicate', { snapshot, media });
        },
        capturePaste(input: ClipboardInput, intent: ClipboardIntent) {
            const target = capturePasteTarget(intent);
            return { cachePin: target.cachePin, run: (signal?: AbortSignal) => target.run(input, signal), release: target.release };
        },
        /** Never throws: a refused target is a rejection the caller reports, not an exception lost in a change handler. */
        importFiles(files: readonly File[], point: ClipboardPoint): Promise<void> {
            if (!files.length) return Promise.resolve();
            try {
                const target = targetNow(point);
                const input: ClipboardInput = { html: null, text: null, svg: null, uriList: null, privatePng: null,
                    files: files.map(file => ({ blob: file, name: file.name, directory: false })) };
                return execute(Promise.resolve(input), target, 'drop');
            } catch (error) { return Promise.reject(error); }
        },
        cancelPending() {
            const cancelled = jobs.size > 0;
            for (const job of jobs) job.abort();
            return cancelled;
        },
        dragover: acceptsBoardDrag,
        drop(event: DragEvent) {
            if (!event.dataTransfer || !acceptsBoardDrag(event)) return false;
            report(() => { const point = surfaceToWorld(options.surfacePoint(event.clientX, event.clientY), options.camera.camera);
                const target = targetNow(point), input = captureTransfer(event.dataTransfer!); void execute(Promise.resolve(input), target, 'drop').catch(pasteFailure); });
            return true;
        },
        retire(onIdle: () => void) { if (disposed) { onIdle(); return; } retired = onIdle; releaseRetired(); },
        dispose() { if (!disposed) { disposed = true; lifetime.abort(); } },
    };
}
